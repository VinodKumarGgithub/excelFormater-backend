import redis from "../lib/redis.js";
import { redisKeys } from "../lib/redis/redisKeys.js";
import axios from "axios";

// Configure axios instance with defaults
const api = axios.create({
  timeout: 30000,
  validateStatus: status => status < 300 // Retry only on 500+ errors
});

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
        multi.pfadd(`${redisKeys.apiStats(sessionId)}:success`, requestId);
      // Use Lists for time-series data
      multi.lpush(`${chartKeyPrefix}:requests:${roundedTime}:success`, requestId);
      // Track status code distribution using Lists for time-series
      const statusCode = response.status;
      multi.lpush(`${chartKeyPrefix}:status:${roundedTime}:${statusCode}`, requestId);
      multi.pfadd(`${redisKeys.apiStats(sessionId)}:status:${statusCode}`, requestId);
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

  // Export functions for API routes
export const apiContextFunctions = {
    getSessionStats,
    getApiRequestsForTable,
    retryApiRequest
  };