import { logger } from './loggerService.js';
import redis from '../config/redisConfig.js';

/**
 * Check if circuit breaker is active
 * @param {string} sessionId - Session ID
 * @param {string} jobId - Job ID
 * @param {string} batchId - Batch ID
 * @param {string} requestId - Request ID
 * @returns {Promise<boolean>} - True if circuit breaker is active
 */
export async function isCircuitBreakerActive(sessionId, jobId, batchId, requestId) {
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
