/**
 * Metrics-related helper functions
 */
import redis from '../config/redisConfig.js';
import { logger } from '../services/loggerService.js';
import { HISTORY_LENGTH } from '../constants/concurrency.js';
import { ERROR_WINDOW_MS } from '../constants/api.js';

// In-memory API error tracking
let apiErrorTimestamps = [];

/**
 * Calculate moving average for an array of values
 * @param {Array<number>} arr - Array of numeric values
 * @returns {number} - Moving average
 */
export function movingAverage(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Detect trend direction in data
 * @param {Array<number>} arr - Array of numeric values
 * @returns {number} - Trend direction: 1 (rising), -1 (falling), 0 (stable)
 */
export function detectTrend(arr) {
  if (arr.length < 2) return 0; // Not enough data
  
  // Compare most recent values to determine trend
  const mostRecent = arr[arr.length - 1];
  const previous = arr[arr.length - 2];
  
  if (mostRecent > previous * 1.1) return 1; // Rising trend (10% increase)
  if (mostRecent < previous * 0.9) return -1; // Falling trend (10% decrease)
  return 0; // Stable
}

/**
 * Extract hour from timestamp for pattern detection
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {number} - Hour (0-23)
 */
export function getHourFromTimestamp(timestamp) {
  return new Date(timestamp).getHours();
}

/**
 * Track API errors for error rate calculation
 * @param {boolean} isError - Whether an error occurred
 */
export function trackApiErrorRate(isError) {
  const now = Date.now();
  // Remove old errors
  apiErrorTimestamps = apiErrorTimestamps.filter(ts => now - ts < ERROR_WINDOW_MS);
  if (isError) {
    apiErrorTimestamps.push(now);
    
    // Also store in Redis for distributed tracking
    try {
      redis.rpush('metrics:errorTimestamps', now.toString());
      // Trim the Redis list to prevent unbounded growth
      redis.ltrim('metrics:errorTimestamps', -100, -1);
    } catch (err) {
      // Non-critical, just log
      logger.warn('Failed to store error timestamp in Redis');
    }
  }
}

/**
 * Calculate current API error rate
 * @returns {number} - Error rate (errors per minute)
 */
export function getApiErrorRate() {
  const now = Date.now();
  
  // First use local timestamps
  apiErrorTimestamps = apiErrorTimestamps.filter(ts => now - ts < ERROR_WINDOW_MS);
  
  // Try to enrich with Redis data
  try {
    redis.lrange('metrics:errorTimestamps', 0, -1).then(timestamps => {
      // Convert to numbers and filter by window
      const redisTimestamps = timestamps
        .map(ts => parseInt(ts))
        .filter(ts => !isNaN(ts) && now - ts < ERROR_WINDOW_MS);
        
      // Merge with local but avoid duplicates
      const localTimes = new Set(apiErrorTimestamps);
      redisTimestamps.forEach(ts => {
        if (!localTimes.has(ts)) {
          apiErrorTimestamps.push(ts);
        }
      });
    });
  } catch (err) {
    // Non-critical, just use local data
    logger.warn('Failed to get error timestamps from Redis');
  }
  
  // For demo: error rate = errors per minute
  return apiErrorTimestamps.length / (ERROR_WINDOW_MS / 60000);
} 