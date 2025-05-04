/**
 * Rate limiting service - provides rate limiting functionality and auto-tuning
 */
import Bottleneck from 'bottleneck';
import { logger } from '../services/loggerService.js';
import redis from '../config/redisConfig.js';
import { getApiErrorRate } from '../helpers/metrics.js';

// Enhanced rate limiter with auto-tuning capability
export const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 100, // Minimum time between requests
  highWater: 1000, // Maximum queue size
  strategy: Bottleneck.strategy.BLOCK, // When queue is full, block new requests
  reservoir: 100, // Initial number of requests allowed
  reservoirRefreshAmount: 100, // How many requests to replenish
  reservoirRefreshInterval: 60 * 1000, // Replenish every minute
});

// Track response times for rate limiter tuning
let responseTimes = [];
const RESPONSE_TIME_HISTORY = 20;

// Auto-tune rate limiter based on response metrics
let rateLimiterTuneInterval = null;

/**
 * Start auto-tuning of rate limiter based on API performance
 */
export function startRateLimiterTuning() {
  if (rateLimiterTuneInterval) return;
  
  rateLimiterTuneInterval = setInterval(async () => {
    // Get current error rate
    const errorRate = getApiErrorRate();
    const avgResponseTime = responseTimes.length > 0 
      ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length 
      : 0;
    
    // Adjust rate limiter settings based on observed performance
    if (errorRate > 0.1) {
      // High error rate - reduce concurrency and increase delay
      const newMaxConcurrent = Math.max(1, Math.floor(limiter.currentReservoir * 0.8));
      const newMinTime = Math.min(500, limiter.minTime * 1.2);
      
      limiter.updateSettings({
        maxConcurrent: newMaxConcurrent,
        minTime: newMinTime
      });
      
      logger.info({
        newMaxConcurrent,
        newMinTime,
        errorRate,
        reason: 'HIGH_ERROR_RATE'
      }, 'Rate limiter auto-tuned');
    } else if (errorRate < 0.01 && avgResponseTime < 200) {
      // Low error rate and good response times - increase capacity
      const newMaxConcurrent = Math.min(20, Math.ceil(limiter.currentReservoir * 1.1));
      const newMinTime = Math.max(50, Math.floor(limiter.minTime * 0.9));
      
      limiter.updateSettings({
        maxConcurrent: newMaxConcurrent,
        minTime: newMinTime
      });
      
      logger.info({
        newMaxConcurrent,
        newMinTime,
        errorRate,
        avgResponseTime,
        reason: 'GOOD_PERFORMANCE'
      }, 'Rate limiter auto-tuned');
    }
    
    // Store rate limiter settings in Redis for monitoring
    try {
      await redis.hset('metrics:rateLimiter', {
        maxConcurrent: limiter.currentReservoir,
        minTime: limiter.minTime,
        errorRate,
        avgResponseTime,
        lastUpdated: Date.now()
      });
    } catch (err) {
      logger.warn('Failed to store rate limiter metrics');
    }
  }, 60000); // Check every minute
}

/**
 * Update response time tracking
 * @param {number} duration - Response time in milliseconds
 */
export function trackResponseTime(duration) {
  responseTimes.push(duration);
  if (responseTimes.length > RESPONSE_TIME_HISTORY) {
    responseTimes.shift();
  }
}

/**
 * Check API rate limit status
 * @returns {Promise<boolean>} - True if rate limited
 */
export async function getApiRateLimitStatus() {
  // First check if we're approaching internal rate limits
  if (limiter.counts().QUEUED > limiter.counts().RECEIVED * 0.8) {
    return true;
  }
  
  // Check Redis for rate limit data from other workers
  try {
    const rateLimitData = await redis.hgetall('metrics:rateLimit');
    if (rateLimitData && rateLimitData.isLimited === 'true') {
      return true;
    }
  } catch (err) {
    logger.warn('Failed to check rate limit status from Redis');
  }
  
  return false;
} 