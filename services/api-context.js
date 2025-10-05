import redis from "../lib/redis.js";
import { redisKeys } from "../lib/redis/redisKeys.js";

// Get session statistics using HyperLogLog
export async function getSessionStats(sessionId) {
    try {
      sessionId = redisKeys.sessionConfig(sessionId);
      
      // Get HyperLogLog counts for total, success, and failure
      const [total, success, failure] = await Promise.all([
        redis.pfcount(`${redisKeys.apiStats(sessionId)}:total`),
        redis.pfcount(`${redisKeys.apiStats(sessionId)}:success`),
        redis.pfcount(`${redisKeys.apiStats(sessionId)}:failure`)
      ]);
      
      // Get status code distribution using HyperLogLog
      const statusCodeKeys = await redis.keys(`${redisKeys.apiStats(sessionId)}:status:*`);
      const statusCodes = {};
      
      if (statusCodeKeys.length > 0) {
        const statusCounts = await Promise.all(
          statusCodeKeys.map(key => 
            redis.pfcount(key).then(count => ({
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
        // const newRequestId = await trackApiCall(sessionId, {
        //   url: originalUrl,
        //   headers: originalHeaders,
        //   body: originalBody,
        //   ...retryContext
        // }, responseData);
        
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

  // Export functions for API routes
export const apiContextFunctions = {
    getSessionStats,
    getApiRequestsForTable,
    retryApiRequest
  };