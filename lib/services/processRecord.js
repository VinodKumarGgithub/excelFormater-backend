/**
 * Record processing service - handles record processing with enhanced error handling and retries
 */
import { logger } from '../services/loggerService.js';
import redis from '../config/redisConfig.js';
import { api } from './apiClient.js';
import { limiter } from './rateLimit.js';
import { trackEndpointPerformance } from './apiClient.js';

/**
 * Process a single record with retries and comprehensive error handling
 * @param {Object} record - Record to process
 * @param {string} apiUrl - API URL
 * @param {Object} headers - Request headers
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @param {number} recordIndex - Record index in batch
 * @param {number} totalRecords - Total records in batch
 * @returns {Promise<Object>} - API response
 */
export async function processRecord(record, apiUrl, headers, sessionId, jobId, recordIndex, totalRecords) {
  // Dynamic retry configuration 
  const maxRetries = 3;
  const getBackoffDelay = (attempt) => Math.pow(2, attempt) * 1000; // Exponential backoff
  
  let attempt = 0;
  const batchId = record.memberId;
  const requestId = record.requestId;
  
  // Track overall processing time for concurrency tuning
  const processingStartTime = Date.now();

  // Check circuit breaker status first
  try {
    const circuitBreakerStatus = await redis.hgetall('metrics:circuitBreaker');
    if (circuitBreakerStatus && circuitBreakerStatus.lastTripped) {
      const tripTime = parseInt(circuitBreakerStatus.lastTripped);
      const resetTimeout = 60000; // 1 minute - Should match worker.js
      
      if (Date.now() - tripTime < resetTimeout) {
        // Circuit breaker is active, fast-fail this request
        await logger.warn({
          sessionId,
          jobId,
          batchId,
          requestId,
          type: 'WARN',
          message: `Skipping processing due to active circuit breaker`,
          meta: {
            tripTime: new Date(parseInt(circuitBreakerStatus.lastTripped)).toISOString(),
            reason: circuitBreakerStatus.reason || 'UNKNOWN'
          }
        });
        
        throw new Error('Circuit breaker active - request rejected');
      }
    }
  } catch (err) {
    // Non-critical error, continue with processing
    logger.warn('Failed to check circuit breaker status');
  }

  while (attempt < maxRetries) {
    try {
      const apiCallStart = Date.now();
      const apiCallMeta = {
        apiUrl,
        attempt: attempt + 1,
        requestPayload: record,
        headers,
      };
      
      // Use rate limiter for API calls
      const response = await limiter.schedule(() => 
        api.post(apiUrl, record, { 
          headers,
          // Add timeout that increases with each retry attempt
          timeout: 10000 + (attempt * 5000)
        })
      );
      
      const apiCallEnd = Date.now();
      const apiCallDuration = apiCallEnd - apiCallStart;
      
      apiCallMeta.status = response.status;
      apiCallMeta.responseData = response.data;
      apiCallMeta.responseHeaders = response.headers;
      apiCallMeta.durationMs = apiCallDuration;

      // Track endpoint performance
      trackEndpointPerformance(apiUrl, apiCallDuration);

      // Log API call (request + response)
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'API_CALL',
        message: `API call for record ${recordIndex + 1}/${totalRecords}`,
        meta: apiCallMeta
      });

      // Log success
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'SUCCESS',
        message: `Processed record ${recordIndex + 1}/${totalRecords}`,
        meta: {
          durationMs: apiCallDuration,
          attempts: attempt + 1
        }
      });

      return response;
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      const errorMessage = err.response?.headers?.['response-description'] || err.message;
      const statusCode = err.response?.status || 0;
      
      // Handle specific error types for enhanced retry logic
      let shouldRetry = !isLastAttempt;
      let retryDelay = getBackoffDelay(attempt);
      
      // Don't retry 4xx client errors except specific retryable ones
      if (statusCode >= 400 && statusCode < 500) {
        // Only retry rate limiting (429) and temporary authentication issues
        shouldRetry = [429, 401, 403].includes(statusCode) && !isLastAttempt;
        
        // For rate limiting, use the Retry-After header if available
        if (statusCode === 429 && err.response?.headers?.['retry-after']) {
          const retryAfter = parseInt(err.response.headers['retry-after']);
          if (!isNaN(retryAfter)) {
            retryDelay = retryAfter * 1000; // Convert to ms
          } else {
            // If retry-after is a date string
            const retryDate = new Date(err.response.headers['retry-after']);
            if (!isNaN(retryDate.getTime())) {
              retryDelay = Math.max(1000, retryDate.getTime() - Date.now());
            }
          }
        }
      }
      
      const apiCallMeta = {
        apiUrl,
        attempt,
        requestPayload: record,
        headers,
        error: errorMessage,
        status: statusCode,
        responseHeaders: err.response?.headers,
        responseData: err.response?.data,
        willRetry: shouldRetry,
        retryDelay: shouldRetry ? retryDelay : 0
      };
      
      // Log API call (request + error)
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'API_CALL',
        message: `API call for record ${recordIndex + 1}/${totalRecords}`,
        meta: apiCallMeta
      });
      
      // Log retry info or final error
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: isLastAttempt ? 'ERROR' : 'WARN',
        message: `Attempt ${attempt}/${maxRetries} failed for record ${recordIndex + 1}`,
        meta: {
          error: errorMessage,
          status: statusCode,
          willRetry: shouldRetry,
          retryDelay: shouldRetry ? retryDelay : 0
        }
      });
      
      // Check if we should stop all processing (potential global issue)
      if ((statusCode === 429 || statusCode >= 500) && attempt === maxRetries) {
        // Try to update circuit breaker status
        try {
          await redis.hset('metrics:recordErrors', {
            [`${apiUrl}:${statusCode}`]: (parseInt(await redis.hget('metrics:recordErrors', `${apiUrl}:${statusCode}`)) || 0) + 1,
            lastError: Date.now(),
            lastErrorDetails: JSON.stringify({
              url: apiUrl,
              status: statusCode,
              error: errorMessage
            })
          });
        } catch (e) {
          // Non-critical, just log
          logger.error('Failed to update error metrics');
        }
      }
      
      if (isLastAttempt || !shouldRetry) {
        throw err;
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
} 