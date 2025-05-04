/**
 * API client service - provides enhanced API client with metrics tracking
 */
import axios from 'axios';
import { trackApiErrorRate } from '../helpers/metrics.js';
import { trackResponseTime } from './rateLimit.js';
import { logger } from '../services/loggerService.js';
import redis from '../config/redisConfig.js';

// Enhanced status code and API metrics tracking
let statusCodeCounts = {};
let apiCallsByMinute = {};
let responseTimesByEndpoint = {};
let latestEndpointPatterns = {};
const ENDPOINT_HISTORY_SIZE = 10;

// Configure axios instance with enhanced settings
export const api = axios.create({
  timeout: 10000,
  validateStatus: status => status < 500, // Retry only on 500+ errors
  headers: {
    'User-Agent': 'POC-Excel-Formatter/1.0',
    'Content-Type': 'application/json'
  }
});

// Set up axios interceptors for comprehensive metrics
api.interceptors.request.use(config => {
  config.metadata = { startTime: Date.now() };
  return config;
}, error => {
  return Promise.reject(error);
});

api.interceptors.response.use(response => {
  const duration = Date.now() - response.config.metadata.startTime;
  response.duration = duration;
  // Track successful response
  trackApiResponseMetrics(duration, response.status, false);
  return response;
}, error => {
  if (error.response) {
    const duration = Date.now() - error.config.metadata.startTime;
    error.response.duration = duration;
    // Track error response
    trackApiResponseMetrics(duration, error.response.status, true);
  } else {
    // Network error or timeout
    trackApiResponseMetrics(10000, 0, true);
  }
  return Promise.reject(error);
});

/**
 * Track API response metrics
 * @param {number} duration - Response time in milliseconds
 * @param {number} status - HTTP status code
 * @param {boolean} isError - Whether this response is an error
 */
export function trackApiResponseMetrics(duration, status, isError) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  
  // Track response times for rate limiter
  trackResponseTime(duration);
  
  // Track by status code
  if (!statusCodeCounts[status]) {
    statusCodeCounts[status] = 0;
  }
  statusCodeCounts[status]++;
  
  // Track by minute for trend analysis
  if (!apiCallsByMinute[minute]) {
    apiCallsByMinute[minute] = { success: 0, error: 0, totalDuration: 0 };
    
    // Clean up old minute data (keep last 60 minutes)
    const minutesToKeep = Object.keys(apiCallsByMinute)
      .sort((a, b) => b - a)
      .slice(0, 60);
      
    const newApiCallsByMinute = {};
    minutesToKeep.forEach(m => {
      newApiCallsByMinute[m] = apiCallsByMinute[m];
    });
    
    apiCallsByMinute = newApiCallsByMinute;
  }
  
  if (isError) {
    apiCallsByMinute[minute].error++;
    // Also track error for circuit breaker
    trackApiErrorRate(true);
  } else {
    apiCallsByMinute[minute].success++;
  }
  
  apiCallsByMinute[minute].totalDuration += duration;
  
  // Store latest metrics in Redis
  try {
    redis.hset('metrics:apiPerformance', {
      avgResponseTime: (duration).toString(),
      callsLastMinute: (apiCallsByMinute[minute].success + apiCallsByMinute[minute].error).toString(),
      timestamp: now.toString(),
      statusCodes: JSON.stringify(statusCodeCounts)
    });
  } catch (err) {
    // Non-critical error, just log
    logger.warn({ error: err.message }, 'Failed to store API metrics');
  }
}

/**
 * Track endpoint performance
 * @param {string} url - API URL
 * @param {number} duration - Response time in milliseconds
 */
export function trackEndpointPerformance(url, duration) {
  // Extract API endpoint pattern from URL for trend analysis
  const urlPattern = url.replace(/\d+/g, ':id').replace(/[a-f0-9]{32}/gi, ':uuid');
  
  if (!latestEndpointPatterns[urlPattern]) {
    latestEndpointPatterns[urlPattern] = [];
  }
  
  latestEndpointPatterns[urlPattern].push(duration);
  if (latestEndpointPatterns[urlPattern].length > ENDPOINT_HISTORY_SIZE) {
    latestEndpointPatterns[urlPattern].shift();
  }
  
  // Store endpoint performance metrics in Redis
  try {
    const avgEndpointTime = latestEndpointPatterns[urlPattern].reduce((a, b) => a + b, 0) / 
                          latestEndpointPatterns[urlPattern].length;
                          
    redis.hset(`metrics:endpoints`, {
      [urlPattern]: JSON.stringify({
        avgTime: avgEndpointTime,
        calls: latestEndpointPatterns[urlPattern].length,
        lastUpdated: Date.now()
      })
    });
  } catch (err) {
    // Non-critical, just log
    logger.warn({ error: err.message }, 'Failed to store endpoint metrics');
  }
} 