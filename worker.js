import { Worker, Job } from 'bullmq';
import axios from 'axios';
import fs from 'fs/promises';
import redis from './lib/redis.js';
import path from 'path';
import Bottleneck from 'bottleneck';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Configure rate limiter
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 100 // Minimum time between requests
});

// Configure axios instance with defaults
const api = axios.create({
  timeout: 10000,
  validateStatus: status => status < 500 // Retry only on 500+ errors
});

// Save API request/response data and update session statistics
async function trackApiCall(sessionId, requestData, responseData) {
  try {
    // Generate unique ID using timestamp and random value
    const reqId = requestData.requestId || `random-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Determine if the response should be considered a failure based on status code
    // Consider any 4xx or 5xx response as a failure
    const statusCode = responseData.status || responseData.error?.status || 0;
    const isHttpError = statusCode >= 400;
    
    // Override the success flag if we have an HTTP error status
    if (isHttpError && responseData.success) {
      responseData.success = false;
    }

    // Store request/response in Redis hash (efficient for large number of fields)
    // Key format: apidata:{sessionId}:{reqId}
    const key = `apidata:${sessionId}:${reqId}`;
    const dataToStore = {
      timestamp: new Date().toISOString(),
      requestUrl: requestData.url,
      requestMethod: 'POST',
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
    await redis.zadd(`apirequests:${sessionId}`, Date.now(), reqId);
    
    // Update session-level statistics
    const pipeline = redis.pipeline();
    
    // Increment total request count
    pipeline.hincrby(`apistats:${sessionId}`, 'total', 1);
    
    // Increment success or failure count
    if (responseData.success) {
      pipeline.hincrby(`apistats:${sessionId}`, 'success', 1);
    } else {
      pipeline.hincrby(`apistats:${sessionId}`, 'failure', 1);
    }
    
    // Track status code distribution
    if (statusCode) {
      pipeline.hincrby(`apistats:${sessionId}`, `status:${statusCode}`, 1);
    }
    
    // Execute all updates atomically
    await pipeline.exec();
    
    return reqId;
  } catch (err) {
    console.error('Error tracking API call:', err.message);
    // Don't throw - logging shouldn't interrupt processing
    return null;
  }
}

// Process single record with retries
async function processRecord(record, apiUrl, headers, sessionId, jobId, recordIndex, totalRecords) {
  const maxRetries = 3;
  let attempt = 0;

  // Prepare request data
  const requestData = {
    url: apiUrl,
    headers,
    body: record,
    sessionId,
    jobId,
    recordIndex
  };

  while (attempt < maxRetries) {
    const startTime = Date.now();
    
    try {
      // Use rate limiter for API calls
      const response = await limiter.schedule(() => 
        api.post(apiUrl, record, { headers })
      );
      
      // Check if this is a 4xx or 5xx response
      const isHttpError = response.status >= 400;
      
      // Prepare response data
      const responseData = {
        status: response.status,
        headers: response.headers,
        data: response.data,
        success: !isHttpError, // Mark 4xx/5xx as failures
        timeMs: Date.now() - startTime,
        attempt: attempt + 1
      };
      
      // For HTTP errors, add error information
      if (isHttpError) {
        responseData.error = {
          message: response.headers['response-description'] || `HTTP Error: ${response.status}`,
          name: 'HttpError',
          httpStatus: response.status
        };
      }
      
      // Track this API call
      await trackApiCall(sessionId, requestData, responseData);
      
      // Only retry on 5xx errors (server errors)
      if (response.status >= 500 && attempt < maxRetries - 1) {
        attempt++;
        // Exponential backoff for server errors
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        continue;
      }
      
      return response;
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      
      // Prepare error response data
      const errorData = {
        status: err.response?.status,
        headers: err.response?.headers,
        data: err.response?.data,
        error: {
          message: err.message || err.response?.headers['response-description'],
          name: err.name,
          stack: process.env.NODE_ENV === 'production' ? null : err.stack
        },
        success: false,
        timeMs: Date.now() - startTime,
        attempt
      };
      
      // Track this failed API call
      await trackApiCall(sessionId, requestData, errorData);
      
      if (isLastAttempt) throw err;
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

// Get session statistics
export async function getSessionStats(sessionId) {
  try {
    sessionId = `session:${sessionId}`;
    const stats = await redis.hgetall(`apistats:${sessionId}`);
    if (!stats || Object.keys(stats).length === 0) {
      return {
        total: 0,
        success: 0,
        failure: 0,
        statusCodes: {}
      };
    }
    
    // Extract status code information
    const statusCodes = {};
    Object.entries(stats).forEach(([key, value]) => {
      if (key.startsWith('status:')) {
        const code = key.replace('status:', '');
        statusCodes[code] = parseInt(value);
      }
    });
    
    return {
      total: parseInt(stats.total || 0),
      success: parseInt(stats.success || 0),
      failure: parseInt(stats.failure || 0),
      statusCodes
    };
  } catch (err) {
    console.error('Error getting session stats:', err.message);
    return {
      total: 0,
      success: 0,
      failure: 0,
      statusCodes: {}
    };
  }
}

// Get API requests for UI table with pagination
export async function getApiRequestsForTable(sessionId, page = 0, pageSize = 50) {
  try {
    sessionId = `session:${sessionId}`;
    // Get total count
    const total = await redis.zcard(`apirequests:${sessionId}`);
    
    // Calculate range for this page
    const start = page * pageSize;
    const end = start + pageSize - 1;
    
    // Get request IDs for this page (newest first)
    const reqIds = await redis.zrevrange(`apirequests:${sessionId}`, start, end);
    
    if (!reqIds || reqIds.length === 0) {
      return {
        total,
        page,
        pageSize,
        data: []
      };
    }
    
    // Get request data for each ID
    const requests = [];
    for (const reqId of reqIds) {
      const data = await redis.hgetall(`apidata:${sessionId}:${reqId}`);
      if (data) {
        // Convert JSON strings back to objects where needed
        if (data.requestHeaders) data.requestHeaders = JSON.parse(data.requestHeaders);
        if (data.requestBody) data.requestBody = JSON.parse(data.requestBody);
        if (data.responseHeaders) data.responseHeaders = JSON.parse(data.responseHeaders);
        if (data.responseData) data.responseData = JSON.parse(data.responseData);
        
        // Convert string numbers to actual numbers
        data.responseStatus = parseInt(data.responseStatus || 0);
        data.success = data.success === '1';
        data.timeMs = parseInt(data.timeMs || 0);
        
        // Add the request ID
        data.id = reqId;
        
        // Add flag to indicate if this request can be retried (4xx errors)
        data.canRetry = !data.success && data.responseStatus >= 400 && data.responseStatus < 500;
        
        requests.push(data);
      }
    }
    
    return {
      total,
      page,
      pageSize,
      data: requests
    };
  } catch (err) {
    console.error('Error getting API requests for table:', err.message);
    return {
      total: 0,
      page,
      pageSize,
      data: []
    };
  }
}

// Function to retry a specific API request with optional modifications
export async function retryApiRequest(sessionId, requestId, modifiedRequestBody) {
  try {
    // Get the original request data
    const requestData = await redis.hgetall(`apidata:${sessionId}:${requestId}`);
    if (!requestData) {
      throw new Error('Original request not found');
    }
    
    // Parse the original data
    const originalHeaders = JSON.parse(requestData.requestHeaders || '{}');
    const originalUrl = requestData.requestUrl;
    const originalBody = modifiedRequestBody || JSON.parse(requestData.requestBody || '{}');
    
    // Get session config to verify we can still access the API
    const configJson = await redis.get(sessionId);
    if (!configJson) {
      throw new Error('Session configuration not found');
    }
    
    const config = JSON.parse(configJson);
    
    // Create retry context
    const retryContext = {
      originalRequestId: requestId,
      timestamp: new Date().toISOString(),
      isRetry: true
    };
    
    // Execute the retry
    const startTime = Date.now();
    try {
      const response = await api.post(originalUrl, originalBody, { 
        headers: originalHeaders 
      });
      
      // Check if this is a 4xx or 5xx response
      const isHttpError = response.status >= 400;
      
      // Prepare response data
      const responseData = {
        status: response.status,
        headers: response.headers,
        data: response.data,
        success: !isHttpError,
        timeMs: Date.now() - startTime,
        attempt: 1,
        isRetry: true,
        originalRequestId: requestId
      };
      
      // For HTTP errors, add error information
      if (isHttpError) {
        responseData.error = {
          message: response.headers['response-description'] || `HTTP Error: ${response.status}`,
          name: 'HttpError',
          httpStatus: response.status
        };
      }
      
      // Track the retry
      const newRequestId = await trackApiCall(sessionId, {
        url: originalUrl,
        headers: originalHeaders,
        body: originalBody,
        ...retryContext
      }, responseData);
      
      return {
        success: true,
        originalRequestId: requestId,
        newRequestId,
        response: {
          status: response.status,
          success: !isHttpError,
          data: response.data
        }
      };
    } catch (err) {
      // Handle error case
      const errorData = {
        status: err.response?.status,
        headers: err.response?.headers,
        data: err.response?.data,
        error: {
          message: err.message || err.response?.headers['response-description'],
          name: err.name,
          stack: process.env.NODE_ENV === 'production' ? null : err.stack
        },
        success: false,
        timeMs: Date.now() - startTime,
        attempt: 1,
        isRetry: true,
        originalRequestId: requestId
      };
      
      // Track the failed retry
      const newRequestId = await trackApiCall(sessionId, {
        url: originalUrl,
        headers: originalHeaders,
        body: originalBody,
        ...retryContext
      }, errorData);
      
      return {
        success: false,
        originalRequestId: requestId,
        newRequestId,
        error: {
          message: err.message,
          status: err.response?.status
        }
      };
    }
  } catch (err) {
    console.error('Error retrying API request:', err.message);
    throw err;
  }
}

// Enhanced worker with better error handling and monitoring
const newWorker = new Worker(
  'batchQueue',
  async (job) => {
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

    const { apiUrl, auth } = JSON.parse(configJson);
    const headers = {
      Authorization: `Basic ${Buffer.from(`${auth.userId}:${auth.apiKey}`).toString('base64')}`,
      'X-User-Id': auth.userId,
    };

    // Process records with progress tracking
    for (let i = 0; i < records.length; i++) {
      try {
        await processRecord(records[i], apiUrl, headers, sessionId, jobId, i, records.length);
        successCount++;
      } catch (err) {
        failureCount++;
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
    concurrency: 20,
    limiter: {
      max: 1000,
      duration: 5000
    },
    settings: {
      retryProcessDelay: 5000,
      backoffDelay: 5000
    }
  }
);

// Export functions for API routes
export const apiContextFunctions = {
  getSessionStats,
  getApiRequestsForTable,
  retryApiRequest
};

// Enhanced event handlers
newWorker.on('completed', async (job) => {
  const { successCount, failureCount, totalRecords } = job.returnvalue;
});
// Graceful shutdown
process.on('SIGTERM', async () => {
  await newWorker.close();
  process.exit(0);
});
