/**
 * Record processing service - handles record processing with enhanced error handling and retries
 */
import { logger } from '../services/loggerService.js';
import redis from '../config/redisConfig.js';
import { api } from './apiClient.js';
import { limiter } from './rateLimit.js';
import { trackEndpointPerformance } from './apiClient.js';
import workerPool from './workerPool.js';
import { ERROR_CATEGORIES } from './workerPool.js';

/**
 * Check if circuit breaker is active
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @param {string} batchId - Batch ID
 * @param {string} requestId - Request ID
 * @returns {Promise<boolean>} - True if circuit breaker is active
 */
async function isCircuitBreakerActive(sessionId, jobId, batchId, requestId) {
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
        
        return true;
      }
    }
    return false;
  } catch (err) {
    // Non-critical error, continue with processing
    logger.warn('Failed to check circuit breaker status');
    return false;
  }
}

/**
 * Store a user action error for later handling
 * @param {Object} error - The error object
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @param {Object} record - The record that caused the error
 */
async function storeUserActionError(error, sessionId, jobId, record) {
  try {
    const errorId = `${sessionId}:${jobId}:${Date.now()}`;
    const errorData = {
      errorId,
      sessionId,
      jobId,
      timestamp: new Date().toISOString(),
      statusCode: error.statusCode,
      category: error.category,
      message: error.message,
      validationErrors: error.validationErrors,
      permissionInfo: error.permissionInfo,
      userActionGuidance: error.userActionGuidance,
      record: JSON.stringify(record),
      resolved: false
    };
    
    // Store in Redis with TTL of 24 hours
    await redis.setex(`userActionError:${errorId}`, 86400, JSON.stringify(errorData));
    
    // Add to list of errors for this session
    await redis.lpush(`userActionErrors:${sessionId}`, errorId);
    await redis.expire(`userActionErrors:${sessionId}`, 86400);
    
    logger.info({
      sessionId,
      jobId,
      errorId,
      type: 'USER_ACTION_REQUIRED',
      message: `User action required: ${error.message}`,
      meta: {
        statusCode: error.statusCode,
        validationErrors: error.validationErrors,
        userActionGuidance: error.userActionGuidance
      }
    });
    
    return errorId;
  } catch (err) {
    logger.error({
      error: err.message,
      originalError: error.message
    }, 'Failed to store user action error');
    return null;
  }
}

/**
 * Store a successful API response for later reference
 * @param {Object} response - The API response
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @param {Object} record - The record that was processed
 */
async function storeSuccessfulApiResponse(response, sessionId, jobId, record) {
  try {
    const responseId = `${sessionId}:${jobId}:${Date.now()}`;
    const responseData = {
      responseId,
      sessionId,
      jobId,
      timestamp: new Date().toISOString(),
      statusCode: response.status,
      headers: response.headers,
      data: response.data,
      record: JSON.stringify(record),
      durationMs: response.duration || 0
    };
    
    // Store in Redis with TTL of 24 hours
    await redis.setex(`successResponse:${responseId}`, 86400, JSON.stringify(responseData));
    
    // Add to list of successful responses for this session
    await redis.lpush(`successResponses:${sessionId}`, responseId);
    await redis.expire(`successResponses:${sessionId}`, 86400);
    
    logger.debug({
      sessionId,
      jobId,
      responseId,
      type: 'SUCCESS_STORED',
      message: `Stored successful API response`,
      meta: {
        statusCode: response.status
      }
    });
    
    return responseId;
  } catch (err) {
    logger.error({
      error: err.message
    }, 'Failed to store successful API response');
    return null;
  }
}

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
  
  const batchId = record.memberId;
  const requestId = record.requestId;
  
  // Track overall processing time for concurrency tuning
  const processingStartTime = Date.now();

  // Check circuit breaker status first
  const circuitBreakerActive = await isCircuitBreakerActive(sessionId, jobId, batchId, requestId);
  if (circuitBreakerActive) {
    throw new Error('Circuit breaker active - request rejected');
  }

  try {
    // Use worker pool for API calls to improve performance
    const result = await workerPool.processRecord(record, {
      apiUrl,
          headers,
      retryConfig: {
        maxRetries,
        getBackoffDelay
      }
    });
    
    const apiCallDuration = result.duration;

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
      meta: {
        apiUrl,
        attempt: result.attempts,
        requestPayload: record,
        headers,
        status: result.status,
        responseData: result.data,
        responseHeaders: result.headers,
        durationMs: apiCallDuration
      }
      });

      // Store successful API response
      const responseId = await storeSuccessfulApiResponse(result, sessionId, jobId, record);

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
          attempts: result.attempts,
          responseId
        }
      });

    return {
      data: result.data,
      status: result.status,
      headers: result.headers,
      success: true,
      responseId
    };
  } catch (error) {
    // Parse error from worker
    let err;
    try {
      err = typeof error === 'string' ? JSON.parse(error.message) : error;
    } catch (e) {
      err = { 
        error: error.message || 'Unknown error',
        status: 0,
        category: ERROR_CATEGORIES.UNKNOWN_ERROR
      };
    }
    
    const errorMessage = err.message || 'Unknown error';
    const statusCode = err.statusCode || 0;
    const attempts = err.attempts || 1;
    
    // Log API call error
    await logger.info({
      sessionId,
      jobId,
      batchId,
      requestId,
      type: 'API_CALL',
      message: `API call for record ${recordIndex + 1}/${totalRecords}`,
      meta: {
        apiUrl,
        attempt: attempts,
        requestPayload: record,
        headers,
        error: errorMessage,
        status: statusCode,
        responseHeaders: err.rawError?.headers,
        responseData: err.rawError?.data,
        category: err.category
      }
    });
    
    // Check if this is a user action error (4XX)
    if (err.category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
      // Store for user resolution
      const errorId = await storeUserActionError(err, sessionId, jobId, record);
      
      // Log specific message about user action required
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'USER_ACTION_REQUIRED',
        message: `Record ${recordIndex + 1} requires user action: ${errorMessage}`,
        meta: {
          errorId,
          statusCode,
          validationErrors: err.validationErrors,
          userActionGuidance: err.userActionGuidance,
          permissionInfo: err.permissionInfo
        }
      });
      
      // Enhance the error with action metadata
      err.errorId = errorId;
      err.requiresUserAction = true;
    } else {
      // Log final error for non-user action errors
      await logger.info({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'ERROR',
        message: `Processing failed for record ${recordIndex + 1}`,
        meta: {
          error: errorMessage,
          status: statusCode,
          attempts,
          category: err.category
        }
      });
    }
      
      // Check if we should stop all processing (potential global issue)
    if (statusCode === 429 || statusCode >= 500) {
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
      
        throw err;
  }
}

/**
 * Get user action errors for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array>} - Array of user action errors
 */
export async function getUserActionErrors(sessionId) {
  try {
    // Get error IDs for this session
    const errorIds = await redis.lrange(`userActionErrors:${sessionId}`, 0, -1);
    
    if (!errorIds || errorIds.length === 0) {
      return [];
    }
    
    // Get error details
    const errors = await Promise.all(
      errorIds.map(async (errorId) => {
        const errorData = await redis.get(`userActionError:${errorId}`);
        if (!errorData) return null;
        
        try {
          const error = JSON.parse(errorData);
          // Parse record back from string
          if (error.record) {
            try {
              error.record = JSON.parse(error.record);
            } catch (e) {
              // If record can't be parsed, use as is
            }
          }
          return error;
        } catch (e) {
          return null;
        }
      })
    );
    
    // Filter out nulls and return
    return errors.filter(Boolean);
  } catch (err) {
    logger.error({
      error: err.message,
      sessionId
    }, 'Failed to get user action errors');
    return [];
  }
}

/**
 * Resolve a user action error
 * @param {string} errorId - Error ID
 * @param {Object} resolution - Resolution details
 * @returns {Promise<boolean>} - True if successful
 */
export async function resolveUserActionError(errorId, resolution) {
  try {
    // Get the error
    const errorData = await redis.get(`userActionError:${errorId}`);
    if (!errorData) {
      return false;
    }
    
    // Parse and update
    const error = JSON.parse(errorData);
    error.resolved = true;
    error.resolution = resolution;
    error.resolvedAt = new Date().toISOString();
    
    // Save updated error
    await redis.setex(`userActionError:${errorId}`, 86400, JSON.stringify(error));
    
    logger.info({
      errorId,
      sessionId: error.sessionId,
      jobId: error.jobId,
      type: 'USER_ACTION_RESOLVED',
      message: `User action error resolved: ${errorId}`,
      meta: {
        resolution
      }
    });
    
    return true;
  } catch (err) {
    logger.error({
      error: err.message,
      errorId
    }, 'Failed to resolve user action error');
    return false;
  }
}

/**
 * Get successful API responses for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array>} - Array of successful API responses
 */
export async function getSuccessfulResponses(sessionId) {
  try {
    // Get response IDs for this session
    const responseIds = await redis.lrange(`successResponses:${sessionId}`, 0, -1);
    
    if (!responseIds || responseIds.length === 0) {
      return [];
    }
    
    // Get response details
    const responses = await Promise.all(
      responseIds.map(async (responseId) => {
        const responseData = await redis.get(`successResponse:${responseId}`);
        if (!responseData) return null;
        
        try {
          const response = JSON.parse(responseData);
          // Parse record back from string
          if (response.record) {
            try {
              response.record = JSON.parse(response.record);
            } catch (e) {
              // If record can't be parsed, use as is
            }
          }
          return response;
        } catch (e) {
          return null;
        }
      })
    );
    
    // Filter out nulls and return
    return responses.filter(Boolean);
  } catch (err) {
    logger.error({
      error: err.message,
      sessionId
    }, 'Failed to get successful responses');
    return [];
  }
}

/**
 * Process multiple records in parallel using worker threads
 * @param {Array<Object>} records - Records to process
 * @param {string} apiUrl - API URL
 * @param {Object} headers - Request headers
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @returns {Promise<Object>} - Processing results with success, failure, and user action required counts
 */
export async function batchProcessRecords(records, apiUrl, headers, sessionId, jobId) {
  const batchResults = await workerPool.batchProcess(records, {
    apiUrl,
    headers,
    retryConfig: {
      maxRetries: 3,
      getBackoffDelay: (attempt) => Math.pow(2, attempt) * 1000
    }
  });
  
  // Process user action errors and store successful responses
  let userActionRequiredCount = 0;
  
  for (const result of batchResults) {
    if (result.success) {
      // Store successful API response
      const responseId = await storeSuccessfulApiResponse(
        result.data, 
        sessionId, 
        jobId, 
        result.record
      );
      
      // Add response ID to result
      result.responseId = responseId;
    } else if (result.error?.category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
      userActionRequiredCount++;
      
      // Store user action error
      const errorId = await storeUserActionError(
        result.error, 
        sessionId, 
        jobId, 
        result.record
      );
      
      // Add error ID to result
      result.errorId = errorId;
    }
  }
  
  // Log results
  const successCount = batchResults.filter(r => r.success).length;
  const failureCount = batchResults.length - successCount - userActionRequiredCount;
  
  await logger.info({
    sessionId,
    jobId,
    type: 'BATCH_COMPLETE',
    message: `Batch processing complete`,
    meta: { 
      successCount, 
      failureCount,
      userActionRequiredCount, 
      totalRecords: records.length 
    }
  });
  
  return {
    results: batchResults,
    summary: {
      successCount,
      failureCount,
      userActionRequiredCount,
      totalRecords: records.length
    }
  };
} 