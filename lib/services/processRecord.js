/**
 * Record processing service — orchestrates a single API call with
 * circuit-breaker checks, retry via worker pool, response/error storage,
 * and endpoint performance tracking.
 */
import { logger } from './loggerService.js';
import redis from '../config/redisConfig.js';
import { trackEndpointPerformance } from './apiClient.js';
import workerPool from './workerPool.js';
import { ERROR_CATEGORIES } from './workerPool.js';
import { isCircuitBreakerActive } from './circuitBreaker.js';
import {
  storeUserActionError,
  storeSuccessfulApiResponse
} from './recordStore.js';

/**
 * Process a single record with retries and comprehensive error handling
 */
export async function processRecord(record, apiUrl, headers, sessionId, jobId, recordIndex, totalRecords) {
  const maxRetries = 3;

  const batchId = record.memberId || record.recordId || 'unknown';
  const requestId = record.requestId || `req-${recordIndex}`;

  // Check circuit breaker status first
  const circuitBreakerActive = await isCircuitBreakerActive(sessionId, jobId, batchId, requestId);
  if (circuitBreakerActive) {
    throw new Error('Circuit breaker active - request rejected');
  }

  try {
    // Use worker pool for API calls
    // Note: retryConfig must be fully serializable (no functions) for worker thread cloning
    const result = await workerPool.processRecord(record, {
      apiUrl,
      headers,
      retryConfig: { maxRetries, backoffType: 'exponential', backoffBaseMs: 1000 }
    });

    const apiCallDuration = result.duration;
    trackEndpointPerformance(apiUrl, apiCallDuration);

    // Log API call details
    await logger.info({
      sessionId, jobId, batchId, requestId,
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

    // Persist successful response
    const responseId = await storeSuccessfulApiResponse(result, sessionId, jobId, record);

    await logger.info({
      sessionId, jobId, batchId, requestId,
      type: 'SUCCESS',
      message: `Processed record ${recordIndex + 1}/${totalRecords}`,
      meta: { durationMs: apiCallDuration, attempts: result.attempts, responseId }
    });

    return {
      data: result.data,
      status: result.status,
      headers: result.headers,
      success: true,
      responseId
    };
  } catch (error) {
    // Normalize error shape
    let err;
    try {
      err = typeof error === 'string' ? JSON.parse(error.message) : error;
    } catch (_) {
      err = {
        error: error.message || 'Unknown error',
        status: 0,
        category: ERROR_CATEGORIES.UNKNOWN_ERROR
      };
    }

    const errorMessage = err.message || 'Unknown error';
    const statusCode = err.statusCode || 0;
    const attempts = err.attempts || 1;

    // Log the failed API call
    await logger.info({
      sessionId, jobId, batchId, requestId,
      type: 'API_CALL',
      message: `API call for record ${recordIndex + 1}/${totalRecords}`,
      meta: {
        apiUrl, attempt: attempts, requestPayload: record, headers,
        error: errorMessage, status: statusCode,
        responseHeaders: err.rawError?.headers,
        responseData: err.rawError?.data,
        category: err.category
      }
    });

    // Handle user-actionable errors (4XX)
    if (err.category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
      const errorId = await storeUserActionError(err, sessionId, jobId, record);

      await logger.info({
        sessionId, jobId, batchId, requestId,
        type: 'USER_ACTION_REQUIRED',
        message: `Record ${recordIndex + 1} requires user action: ${errorMessage}`,
        meta: {
          errorId, statusCode,
          validationErrors: err.validationErrors,
          userActionGuidance: err.userActionGuidance,
          permissionInfo: err.permissionInfo
        }
      });

      err.errorId = errorId;
      err.requiresUserAction = true;
    } else {
      await logger.info({
        sessionId, jobId, batchId, requestId,
        type: 'ERROR',
        message: `Processing failed for record ${recordIndex + 1}`,
        meta: { error: errorMessage, status: statusCode, attempts, category: err.category }
      });
    }

    // Track server/rate-limit errors for circuit breaker metrics
    if (statusCode === 429 || statusCode >= 500) {
      try {
        await redis.hset('metrics:recordErrors', {
          [`${apiUrl}:${statusCode}`]: (parseInt(await redis.hget('metrics:recordErrors', `${apiUrl}:${statusCode}`)) || 0) + 1,
          lastError: Date.now(),
          lastErrorDetails: JSON.stringify({ url: apiUrl, status: statusCode, error: errorMessage })
        });
      } catch (_) {
        logger.error('Failed to update error metrics');
      }
    }

    throw err;
  }
}

/**
 * Process multiple records in parallel using worker threads
 */
export async function batchProcessRecords(records, apiUrl, headers, sessionId, jobId) {
  const batchResults = await workerPool.batchProcess(records, {
    apiUrl,
    headers,
    retryConfig: {
      maxRetries: 3,
      backoffType: 'exponential',
      backoffBaseMs: 1000
    }
  });

  let userActionRequiredCount = 0;

  for (const result of batchResults) {
    if (result.success) {
      const responseId = await storeSuccessfulApiResponse(result.data, sessionId, jobId, result.record);
      result.responseId = responseId;
    } else if (result.error?.category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
      userActionRequiredCount++;
      const errorId = await storeUserActionError(result.error, sessionId, jobId, result.record);
      result.errorId = errorId;
    }
  }

  const successCount = batchResults.filter(r => r.success).length;
  const failureCount = batchResults.length - successCount - userActionRequiredCount;

  await logger.info({
    sessionId, jobId,
    type: 'BATCH_COMPLETE',
    message: 'Batch processing complete',
    meta: { successCount, failureCount, userActionRequiredCount, totalRecords: records.length }
  });

  return {
    results: batchResults,
    summary: { successCount, failureCount, userActionRequiredCount, totalRecords: records.length }
  };
}