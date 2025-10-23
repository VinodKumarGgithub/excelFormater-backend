import { Worker, Job } from 'bullmq';
import dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import redis from './lib/redis.js';
import { redisKeys } from './lib/redis/redisKeys.js';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// console.error('Worker started', typeof process.env.WORKER_CONCURRENCY);
// Configure axios instance with defaults
const api = axios.create({
  timeout: 30000,
  validateStatus: status => status < 300 // Retry only on 500+ errors
});

// Save API request/response data and update session statistics using HyperLogLog
async function trackApiCall(sessionId, requestData, responseData, isRetry = false) {
  try {
    // Generate unique ID using timestamp and random value
    const reqId = requestData.body.requestId ? requestData.body.requestId : `random-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Determine if the response should be considered a failure based on status code
    // Consider any 4xx or 5xx response as a failure
    const statusCode = responseData.status || responseData.error?.status || 0;
    const isHttpError = statusCode >= 400;
    
    // Override the success flag if we have an HTTP error status
    if (isHttpError && responseData.success) {
      responseData.success = false;
    }

    // Store request/response in Redis hash (efficient for large number of fields)
    const key = redisKeys.apiData(sessionId, reqId);
    const dataToStore = {
      timestamp: new Date().toISOString(),
      requestUrl: requestData.url,
      requestMethod: requestData.method,
      requestHeaders: JSON.stringify(requestData.headers),
      requestBody: JSON.stringify(requestData.body),
      responseStatus: statusCode,
      responseHeaders: JSON.stringify(responseData.headers || {}),
      responseData: JSON.stringify(responseData.data || responseData.error || {}),
      success: responseData.success ? '1' : '0',
      error: responseData.error?.message || (isHttpError ? `HTTP Error: ${statusCode}` : ''),
      timeMs: responseData.timeMs || 0,
    };
    
    // Use hmset to store all fields at once
    await redis.hmset(key, dataToStore);
    
    // Store this request ID in a sorted set by timestamp for easy retrieval
    // Using timestamp as score for chronological sorting
    await redis.zadd(redisKeys.apiRequests(sessionId), Date.now(), reqId);
  
    return reqId;
  } catch (err) {
    console.error('Error tracking API call:', err.message);
    // Don't throw - logging shouldn't interrupt processing
    return null;
  }
}

// Process single record with retries
async function processRecord(record, apiUrl, auth, sessionId, jobId, recordIndex) {

  // Prepare headers based on auth type
  const headers = {};
  let statusCode = 0;
  let response ;
  const reqId = record.requestId;
  const chartKeyPrefix = redisKeys.apiChart(sessionId); // e.g. api:chart:<sessionId>
  const now = new Date();
  now.setSeconds(0, 0);
  const roundedTime = now.getTime();
  // const id = crypto.randomBytes(12).toString('base64url');
  const multi = redis.multi();
  // Add unique request to set for total count (exact count)
  multi.sadd(redisKeys.apiTotal(sessionId), reqId);
  // Use Lists for time-series data
  multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:total`, reqId);
  
  switch (auth.type) {
    case 'apiKey':
      if (auth.keyLocation === 'header') {
        headers[auth.keyName || 'X-API-Key'] = auth.apiKey;
      } else if (auth.keyLocation === 'query') {
        // Add API key to URL as query parameter
        const url = new URL(apiUrl);
        url.searchParams.append(auth.keyName || 'apiKey', auth.apiKey);
        apiUrl = url.toString();
      }
      break;
      
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      break;
      
    case 'bearerToken':
      headers.Authorization = `Bearer ${auth.token}`;
      break;
      
    case 'none':
    default:
      // No authentication headers needed
      break;
  }

  // Prepare request data
  const requestData = {
    url: apiUrl,
    method: auth.method || 'POST', // Default to POST if not specified
    headers,
    body: record,
    sessionId,
    jobId,
    recordIndex
  };

    const startTime = Date.now();
    let timeMs = 0;
    
    try {
      // let response;
      // Make API call based on HTTP method
      switch (requestData.method.toUpperCase()) {
        case 'GET':
          response = await api.get(apiUrl, { 
            headers,
            params: record // For GET requests, send data as query params
          });
          break;
        case 'POST':
          response = await api.post(apiUrl, record, { headers });
          break;
        case 'PUT':
          response = await api.put(apiUrl, record, { headers });
          break;
        case 'PATCH':
          response = await api.patch(apiUrl, record, { headers });
          break;
        case 'DELETE':
          response = await api.delete(apiUrl, { 
            headers,
            data: record // For DELETE requests, send data in body
          });
          break;
        case 'HEAD':
          response = await api.head(apiUrl, { headers });
          break;
        case 'OPTIONS':
          response = await api.options(apiUrl, { headers });
          break;
        default:
          throw new Error(`Unsupported HTTP method: ${requestData.method}`);
      }
      timeMs = Date.now() - startTime;
      
      multi.sadd(redisKeys.apiSuccess(sessionId), reqId);
      // Use Lists for time-series data
      multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:success`, reqId);
      // Track status code distribution using Lists for time-series
      statusCode = response.status;
      multi.lpush(`${chartKeyPrefix}:status:${roundedTime}:${statusCode}`, reqId);
      multi.sadd(`${redisKeys.apiStats(sessionId)}:status:${statusCode}`, reqId);
    } catch (err) {
      timeMs = Date.now() - startTime;
      // Prepare error response data
      const errorData = {
        status: err.response?.status,
        headers: err.response?.headers,
        data: err.response?.data,
        error: {
          message: err.response?.headers['response-description'] || err.message ,
          name: err.name,
          stack: process.env.NODE_ENV === 'production' ? null : err.stack
        },
        success: false,
        timeMs,
        // attempt
      };
      multi.sadd(redisKeys.apiFailure(sessionId), reqId);
      // Use Lists for time-series data
      multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:failure`, reqId);
      // Track status code distribution using Lists for time-series
      statusCode = err.response?.status;
      multi.lpush(`${chartKeyPrefix}:status:${roundedTime}:${statusCode}`, reqId);
      multi.sadd(`${redisKeys.apiStats(sessionId)}:status:${statusCode}`, reqId);
      // Track this failed API call
      await trackApiCall(sessionId, requestData, errorData);
    }

    // add request time tracking with request with timeMs in hash for avrage calculation in hash
    multi.hincrby(`${chartKeyPrefix}:avglatency`, reqId, timeMs);


    // Track latency data (keep this as it's for averages, not counts)
    multi.hincrby(`${chartKeyPrefix}:latency:${roundedTime}`, 'count', 1);
    multi.hincrbyfloat(`${chartKeyPrefix}:latency:${roundedTime}`, 'totalTimeMs', Date.now() - startTime || 0);
    await multi.exec();

}

// Enhanced worker with better error handling and monitoring
const newWorker = new Worker(
  'batchQueue',
  async (job) => {
    // console.error('Worker started');
    const { sessionId, records } = job.data;
    const jobId = job.id;
    let successCount = 0;
    let failureCount = 0;

    // Validate job data
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('Invalid or empty records array');
    }

    const configJson = await redis.get(sessionId);
    if (!configJson) {
      throw new Error(`No config found for sessionId: ${sessionId}`);
    }

    const { apiUrl, auth, method } = JSON.parse(configJson);

    // Process records sequentially within each job
    for (let i = 0; i < records.length; i++) {
      try {
        await processRecord(records[i], apiUrl, { ...auth, method }, sessionId, jobId, i, records.length);
        successCount++;
      } catch (err) {
        failureCount++;
        // console.error(`Error processing record ${i}:`, err.message);
      }

      // Update progress
      if (i % 5 === 0 || i === records.length - 1) {
        await job.updateProgress({
          completed: i + 1,
          total: records.length,
          successCount,
          failureCount
        });
      }
    }

    return {
      successCount,
      failureCount,
      totalRecords: records.length
    };
  },
  {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 1, // Strictly limit to 10 concurrent jobs
    settings: {
      retryProcessDelay: 5000,
      backoffDelay: 5000
    },
    limiter: {
      max: 1000,
      duration: 5000
    }
  }
);

// Enhanced event handlers
newWorker.on('completed', async (job) => {
  const { successCount, failureCount, totalRecords } = job.returnvalue;
  console.log(`Job ${job.id} completed. Success: ${successCount}, Failure: ${failureCount}, Total: ${totalRecords}`);
});

newWorker.on('failed', async (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

newWorker.on('stalled', async (job) => {
  console.warn(`Job ${job.id} stalled`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await newWorker.close();
  process.exit(0);
});
