import redis from "../lib/redis.js";
import { redisKeys } from "../lib/redis/redisKeys.js";
import axios from "axios";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Configure axios instance with defaults
const api = axios.create({
  timeout: 30000,
  validateStatus: status => status < 300 // Retry only on 500+ errors
});

// Get session statistics using sets
export async function getSessionStats(sessionId) {
    try {
      sessionId = redisKeys.sessionConfig(sessionId);
      
      // Get set counts for total, success, and failure
      const [total, success, failure] = await Promise.all([
        redis.scard(redisKeys.apiTotal(sessionId)),
        redis.scard(redisKeys.apiSuccess(sessionId)),
        redis.scard(redisKeys.apiFailure(sessionId))
      ]);
      
      // Get status code distribution using sets
      const statusCodeKeys = await redis.keys(`${redisKeys.apiStats(sessionId)}:status:*`);
      const statusCodes = {};
      
      if (statusCodeKeys.length > 0) {
        const statusCounts = await Promise.all(
          statusCodeKeys.map(key => 
            redis.scard(key).then(count => ({
              code: key.split(':').pop(),
              count
            }))
          )
        );
        
        statusCounts.forEach(({ code, count }) => {
          statusCodes[code] = count;
        });
      }
      
      return {
        total: total || 0,
        success: success || 0,
        failure: failure || 0,
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
      sessionId = redisKeys.sessionConfig(sessionId);
      // Get total count
      const total = await redis.zcard(redisKeys.apiRequests(sessionId));
      
      // Calculate range for this page
      const start = page * pageSize;
      const end = start + pageSize - 1;
      
      // Get request IDs for this page (newest first)
      const reqIds = await redis.zrevrange(redisKeys.apiRequests(sessionId), start, end);
      
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
        const data = await redis.hgetall(redisKeys.apiData(sessionId, reqId));
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
  
  // Function to get all failed requests for a session
  export async function getFailedRequests(sessionId) {
    try {
      sessionId = redisKeys.sessionConfig(sessionId);
      
      // Get all request IDs from the failure set
      const failedRequestIds = await redis.smembers(redisKeys.apiFailure(sessionId));
      
      if (!failedRequestIds || failedRequestIds.length === 0) {
        return [];
      }
      
      // Get request data for each failed request
      const failedRequests = [];
      for (const reqId of failedRequestIds) {
        const data = await redis.hgetall(redisKeys.apiData(sessionId, reqId));
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
          
          failedRequests.push(data);
        }
      }
      
      return failedRequests;
    } catch (err) {
      console.error('Error getting failed requests:', err.message);
      return [];
    }
  }

  // Function to retry a specific API request with optional modifications
  export async function retryApiRequest(sessionId, requestId, modifiedRequestBody) {
    try {
      // Get the original request data
      const requestData = await redis.hgetall(redisKeys.apiData(sessionId, requestId));
      if (!requestData) {
        throw new Error('Original request not found');
      }
      
      // Parse the original data
      const originalHeaders = JSON.parse(requestData.requestHeaders || '{}');
      const originalUrl = requestData.requestUrl;
      const originalMethod = requestData.requestMethod || 'POST';
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
        // isRetry: true
      };
      
      // Execute the retry
      const startTime = Date.now();
      const now = new Date();
      now.setSeconds(0, 0);
      const roundedTime = now.getTime();
      const chartKeyPrefix = redisKeys.apiChart(sessionId);
      const multi = redis.multi();

      try {
        let response;
        
        // Make API call based on HTTP method
        switch (originalMethod.toUpperCase()) {
          case 'GET':
            response = await api.get(originalUrl, { 
              headers: originalHeaders,
              params: originalBody
            });
            break;
          case 'POST':
            response = await api.post(originalUrl, originalBody, { headers: originalHeaders });
            break;
          case 'PUT':
            response = await api.put(originalUrl, originalBody, { headers: originalHeaders });
            break;
          case 'PATCH':
            response = await api.patch(originalUrl, originalBody, { headers: originalHeaders });
            break;
          case 'DELETE':
            response = await api.delete(originalUrl, { 
              headers: originalHeaders,
              data: originalBody
            });
            break;
          case 'HEAD':
            response = await api.head(originalUrl, { headers: originalHeaders });
            break;
          case 'OPTIONS':
            response = await api.options(originalUrl, { headers: originalHeaders });
            break;
          default:
            throw new Error(`Unsupported HTTP method: ${originalMethod}`);
        }
        
        // Check if this is a 4xx or 5xx response
        const isHttpError = response.status >= 400;
        
        if (!isHttpError) {
          // Move from failure to success set (sadd is idempotent, so safe to call even if already in success set)
          multi.srem(redisKeys.apiFailure(sessionId), requestId);
          multi.sadd(redisKeys.apiSuccess(sessionId), requestId);
          // Remove the stored request data entry after successful retry
          multi.del(redisKeys.apiData(sessionId, requestId));
          // Remove from sorted set used for table display
          multi.zrem(redisKeys.apiRequests(sessionId), requestId);
          // Use Lists for time-series data - success
          multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:success`, requestId);
        } else {
          // Still failed, keep in failure set and add to failure time-series
          multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:failure`, requestId);
        }
        
        // Track status code distribution using Lists for time-series
        const statusCode = response.status;
        multi.lpush(`${chartKeyPrefix}:status:${roundedTime}:${statusCode}`, requestId);
        multi.sadd(`${redisKeys.apiStats(sessionId)}:status:${statusCode}`, requestId);
        
         // Update the stored request data with new response (only if still failed)
         if (isHttpError) {
           const updatedData = {
             timestamp: new Date().toISOString(),
             requestUrl: originalUrl,
             requestMethod: originalMethod,
             requestHeaders: JSON.stringify(originalHeaders),
             requestBody: JSON.stringify(originalBody), // This is the modified body that was sent
             responseStatus: response.status,
             responseHeaders: JSON.stringify(response.headers || {}),
             responseData: JSON.stringify(response.data || {}),
             success: '0',
             error: `HTTP Error: ${response.status}`,
             timeMs: Date.now() - startTime,
           };
           multi.hmset(redisKeys.apiData(sessionId, requestId), updatedData);
           // Update the timestamp in sorted set for table display (so it appears at the top)
           multi.zadd(redisKeys.apiRequests(sessionId), Date.now(), requestId);
         }
        
        await multi.exec();
        
        return {
          success: true,
          originalRequestId: requestId,
          newRequestId: requestId,
          response: {
            status: response.status,
            success: !isHttpError,
            data: response.data
          }
        };
       } catch (err) {
         // Handle retry failure - keep in failure set and update error data
         const errorData = {
           timestamp: new Date().toISOString(),
           requestUrl: originalUrl,
           requestMethod: originalMethod,
           requestHeaders: JSON.stringify(originalHeaders),
           requestBody: JSON.stringify(originalBody), // This is the modified body that was sent
           responseStatus: err.response?.status || 0,
           responseHeaders: JSON.stringify(err.response?.headers || {}),
           responseData: JSON.stringify(err.response?.data || {}),
           success: '0',
           error: err.response?.headers['response-description'] || err.message,
           timeMs: Date.now() - startTime,
         };
         
         // Update the stored request data with error response
         await redis.hmset(redisKeys.apiData(sessionId, requestId), errorData);
         // Update the timestamp in sorted set for table display (so it appears at the top)
         await redis.zadd(redisKeys.apiRequests(sessionId), Date.now(), requestId);
        
        return {
          success: false,
          originalRequestId: requestId,
          newRequestId: requestId,
          error: {
            message: err.response?.headers['response-description'] || err.message,
            status: err.response?.status
          }
        };
      }
    } catch (err) {
      console.error('Error retrying API request:', err.message);
      throw err;
    }
  }

  // Function to retry all failed requests for a session
  export async function retryAllFailedRequests(sessionId) {
    try {
      sessionId = redisKeys.sessionConfig(sessionId);
      
      // Get all failed requests
      const failedRequests = await getFailedRequests(sessionId);
      
      if (failedRequests.length === 0) {
        return {
          success: true,
          message: 'No failed requests found to retry',
          results: [],
          summary: {
            total: 0,
            successful: 0,
            failed: 0
          }
        };
      }
      
      const results = [];
      let successfulRetries = 0;
      let failedRetries = 0;
      
      // Retry each failed request
      for (const request of failedRequests) {
        try {
          const result = await retryApiRequest(sessionId, request.id);
          results.push({
            requestId: request.id,
            success: result.success,
            status: result.response?.status || result.error?.status,
            message: result.response?.data || result.error?.message
          });
          
          if (result.success) {
            successfulRetries++;
          } else {
            failedRetries++;
          }
        } catch (err) {
          results.push({
            requestId: request.id,
            success: false,
            status: 0,
            message: err.message
          });
          failedRetries++;
        }
      }
      
      return {
        success: true,
        message: `Retried ${failedRequests.length} failed requests`,
        results,
        summary: {
          total: failedRequests.length,
          successful: successfulRetries,
          failed: failedRetries
        }
      };
    } catch (err) {
      console.error('Error retrying all failed requests:', err.message);
      throw err;
    }
  }

  // Export functions for API routes
export const apiContextFunctions = {
    getSessionStats,
    getApiRequestsForTable,
    retryApiRequest,
    retryAllFailedRequests,
    getFailedRequests
  };