/**
 * Concurrency management service - handles worker concurrency adjustments
 */
import os from 'os';
import redis from '../../lib/config/redisConfig.js';
import { logger } from '../../lib/services/loggerService.js';
import { getQueueBacklog } from './queueManager.js';
import { getApiErrorRate } from '../helpers/metrics.js';
import { movingAverage, detectTrend, getHourFromTimestamp } from '../helpers/metrics.js';

import {
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  COOLDOWN_MS,
  MAX_DECREASE_STEP,
  CONCURRENCY_STABILITY_THRESHOLD,
  CONCURRENCY_INCREASE_RATE,
  TREND_THRESHOLD,
  HISTORY_LENGTH,
  TREND_HISTORY_LENGTH,
  SYSTEM_HEALTH_HISTORY,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT,
  RECOVERY_MODE_STEP,
  MAX_RECOVERY_STEPS,
  PREDICTION_UPDATE_INTERVAL
} from '../constants/concurrency.js';

// State variables for concurrency management
let currentConcurrency = MIN_CONCURRENCY;
let lastConcurrencyChange = 0;
let consecutiveDecreaseTriggers = 0;
let stabilityCounter = 0;

// Circuit breaker state
let circuitBreakerTripped = false;
let circuitBreakerTripTime = 0;
let previousSystemHealth = [];

// Auto-recovery state
let inRecoveryMode = false;
let recoveryStartConcurrency = 0;
let recoveryTargetConcurrency = 0;
let recoveryStepsTaken = 0;

// Predictive scaling state
let dailyConcurrencyPatterns = {}; // Track patterns by hour
let predictedConcurrencyAdjustment = 0;
let lastPredictionUpdate = 0;

// Trend tracking
let cpuHistory = [];
let memHistory = [];
let errorRateHistory = [];
let backlogHistory = [];
let responseTimeHistory = [];
let cpuTrend = [];
let errorTrend = [];
let backlogTrend = [];
let responseTimeChangeTrend = [];
let lastAvgResponseTime = 0;

/**
 * Update concurrency patterns for predictive scaling
 */
function updateConcurrencyPatterns() {
  const now = Date.now();
  const hour = getHourFromTimestamp(now);
  
  // Only update if system is healthy and concurrency is high
  if (previousSystemHealth.length > 0 && 
      movingAverage(previousSystemHealth) > 0.5 && 
      currentConcurrency > (MIN_CONCURRENCY + MAX_CONCURRENCY) / 2) {
    
    // Initialize if needed
    if (!dailyConcurrencyPatterns[hour]) {
      dailyConcurrencyPatterns[hour] = [];
    }
    
    // Add current concurrency to the pattern data
    dailyConcurrencyPatterns[hour].push(currentConcurrency);
    
    // Keep pattern data manageable
    if (dailyConcurrencyPatterns[hour].length > 10) {
      dailyConcurrencyPatterns[hour].shift();
    }
    
    logger.info({ hour, patterns: dailyConcurrencyPatterns[hour] }, 'Updated concurrency patterns');
  }
}

/**
 * Calculate predictive concurrency adjustment based on historical patterns
 * @returns {number} Suggested concurrency adjustment
 */
function calculatePredictiveConcurrency() {
  const now = Date.now();
  
  // Only recalculate occasionally to avoid thrashing
  if (now - lastPredictionUpdate < PREDICTION_UPDATE_INTERVAL) {
    return predictedConcurrencyAdjustment;
  }
  
  const currentHour = getHourFromTimestamp(now);
  const nextHour = (currentHour + 1) % 24;
  
  // If we have pattern data for the next hour, use it for prediction
  if (dailyConcurrencyPatterns[nextHour] && dailyConcurrencyPatterns[nextHour].length > 0) {
    const avgNextHourConcurrency = dailyConcurrencyPatterns[nextHour].reduce((a, b) => a + b, 0) / 
                                  dailyConcurrencyPatterns[nextHour].length;
    
    // Calculate adjustment relative to current concurrency
    predictedConcurrencyAdjustment = Math.round(avgNextHourConcurrency - currentConcurrency);
    
    // Cap adjustment to avoid extreme changes
    predictedConcurrencyAdjustment = Math.min(5, Math.max(-5, predictedConcurrencyAdjustment));
    
    lastPredictionUpdate = now;
    
    logger.info({ 
      currentHour, 
      nextHour, 
      avgNextHourConcurrency,
      predictedConcurrencyAdjustment
    }, 'Predictive concurrency calculated');
  } else {
    predictedConcurrencyAdjustment = 0;
  }
  
  return predictedConcurrencyAdjustment;
}

/**
 * Monitor and adjust concurrency based on system metrics
 * @returns {Promise<{concurrency: number} | null>} Worker update or null if no change
 */
export async function monitorAndAdjustConcurrency() {
  const now = Date.now();
  
  // Circuit breaker reset check
  if (circuitBreakerTripped && (now - circuitBreakerTripTime > CIRCUIT_BREAKER_RESET_TIMEOUT)) {
    logger.info('Circuit breaker reset - resuming normal operation');
    circuitBreakerTripped = false;
    // Start in recovery mode
    inRecoveryMode = true;
    recoveryStartConcurrency = MIN_CONCURRENCY;
    recoveryTargetConcurrency = Math.floor(MIN_CONCURRENCY * 1.5);
    recoveryStepsTaken = 0;
    currentConcurrency = MIN_CONCURRENCY;
    return { concurrency: currentConcurrency };
  }
  
  // Skip normal monitoring if circuit breaker is tripped
  if (circuitBreakerTripped) {
    logger.info({ tripTime: new Date(circuitBreakerTripTime).toISOString() }, 'Circuit breaker active - skipping adjustment');
    return null;
  }
  
  // Gather metrics
  const cpu = os.loadavg()[0];
  const mem = os.freemem() / os.totalmem();
  const backlog = await getQueueBacklog();
  const apiErrorRate = getApiErrorRate();
  
  try {
    // Get response time data from Redis
    const avgResponseTimeStr = await redis.get('metrics:latestAvgResponseTime');
    if (avgResponseTimeStr) {
      const avgResponseTime = parseFloat(avgResponseTimeStr);
      if (!isNaN(avgResponseTime)) {
        responseTimeHistory.push(avgResponseTime);
        if (responseTimeHistory.length > HISTORY_LENGTH) responseTimeHistory.shift();
      }
    }
  } catch (err) {
    logger.warn('Failed to get response time metrics from Redis');
  }

  // Update histories
  cpuHistory.push(cpu); if (cpuHistory.length > HISTORY_LENGTH) cpuHistory.shift();
  memHistory.push(mem); if (memHistory.length > HISTORY_LENGTH) memHistory.shift();
  errorRateHistory.push(apiErrorRate); if (errorRateHistory.length > HISTORY_LENGTH) errorRateHistory.shift();
  backlogHistory.push(backlog); if (backlogHistory.length > HISTORY_LENGTH) backlogHistory.shift();

  // Calculate trends
  cpuTrend.push(detectTrend(cpuHistory));
  if (cpuTrend.length > TREND_HISTORY_LENGTH) cpuTrend.shift();
  
  errorTrend.push(detectTrend(errorRateHistory));
  if (errorTrend.length > TREND_HISTORY_LENGTH) errorTrend.shift();
  
  backlogTrend.push(detectTrend(backlogHistory));
  if (backlogTrend.length > TREND_HISTORY_LENGTH) backlogTrend.shift();
  
  const avgResponseTime = movingAverage(responseTimeHistory);
  responseTimeChangeTrend.push(lastAvgResponseTime > 0 ? 
    (avgResponseTime - lastAvgResponseTime) / lastAvgResponseTime : 0);
  if (responseTimeChangeTrend.length > TREND_HISTORY_LENGTH) responseTimeChangeTrend.shift();
  lastAvgResponseTime = avgResponseTime;

  const avgCpu = movingAverage(cpuHistory);
  const avgMem = movingAverage(memHistory);
  const avgError = movingAverage(errorRateHistory);
  const avgBacklog = movingAverage(backlogHistory);
  
  // Calculate trend scores (-1 to 1 range where positive means favorable for increasing concurrency)
  const cpuTrendScore = cpuTrend.reduce((acc, val) => acc - val, 0) / cpuTrend.length;
  const errorTrendScore = errorTrend.reduce((acc, val) => acc - val, 0) / errorTrend.length;
  const backlogTrendScore = backlogTrend.reduce((acc, val) => acc + val, 0) / backlogTrend.length;
  const responseTrendScore = responseTimeChangeTrend.reduce((acc, val) => acc - val, 0) / responseTimeChangeTrend.length;
  
  // Combined score (-1 to 1) where higher is better for increasing concurrency
  const systemHealth = (
    (cpuTrendScore * 0.3) + 
    (errorTrendScore * 0.3) + 
    (backlogTrendScore * 0.2) + 
    (responseTrendScore * 0.2)
  );
  
  // Update system health history
  previousSystemHealth.push(systemHealth);
  if (previousSystemHealth.length > SYSTEM_HEALTH_HISTORY) {
    previousSystemHealth.shift();
  }
  
  // Update concurrency patterns
  updateConcurrencyPatterns();
  
  // Calculate predictive adjustment
  const predictiveAdjustment = calculatePredictiveConcurrency();

  logger.info({
    avgCpu, avgMem, avgError, avgBacklog, avgResponseTime,
    systemHealth: systemHealth.toFixed(2),
    currentConcurrency, 
    consecutiveDecreaseTriggers,
    stabilityCounter,
    inRecoveryMode: inRecoveryMode ? `Step ${recoveryStepsTaken}/${MAX_RECOVERY_STEPS}` : false,
    circuitBreakerTripped,
    predictiveAdjustment
  }, 'Resource metrics for concurrency tuning');
  
  // Circuit breaker check - trip if error rate is too high
  if (avgError > CIRCUIT_BREAKER_ERROR_THRESHOLD || systemHealth < -0.7) {
    logger.warn({
      avgError,
      systemHealth: systemHealth.toFixed(2),
      threshold: CIRCUIT_BREAKER_ERROR_THRESHOLD
    }, 'Circuit breaker tripped - reducing to minimum concurrency');
    
    circuitBreakerTripped = true;
    circuitBreakerTripTime = now;
    
    // Store circuit breaker event in Redis for monitoring
    try {
      await redis.hset('metrics:circuitBreaker', {
        lastTripped: now,
        reason: avgError > CIRCUIT_BREAKER_ERROR_THRESHOLD ? 'HIGH_ERROR_RATE' : 'POOR_SYSTEM_HEALTH',
        metrics: JSON.stringify({
          avgError,
          systemHealth: systemHealth.toFixed(2),
          avgCpu,
          avgResponseTime
        })
      });
    } catch (err) {
      logger.error('Failed to record circuit breaker event');
    }
    
    // Reset recovery variables
    inRecoveryMode = false;
    stabilityCounter = 0;
    currentConcurrency = MIN_CONCURRENCY;
    
    return { concurrency: currentConcurrency };
  }

  // Cooldown logic
  if (now - lastConcurrencyChange < COOLDOWN_MS) return null;
  
  // Recovery mode logic
  if (inRecoveryMode) {
    // Step up concurrency gradually during recovery
    recoveryStepsTaken++;
    
    const recoveryStepSize = Math.ceil((recoveryTargetConcurrency - recoveryStartConcurrency) / MAX_RECOVERY_STEPS);
    const newConcurrency = Math.min(
      recoveryTargetConcurrency,
      recoveryStartConcurrency + (recoveryStepSize * recoveryStepsTaken)
    );
    
    // Exit recovery mode if we've reached target or completed steps
    if (recoveryStepsTaken >= MAX_RECOVERY_STEPS || newConcurrency >= recoveryTargetConcurrency) {
      inRecoveryMode = false;
      logger.info({
        finalConcurrency: newConcurrency,
        steps: recoveryStepsTaken
      }, 'Recovery mode completed');
    }
    
    // Apply recovery concurrency change
    if (newConcurrency != currentConcurrency) {
      currentConcurrency = newConcurrency;
      lastConcurrencyChange = now;
      logger.info({
        currentConcurrency,
        recoveryStep: recoveryStepsTaken,
        maxSteps: MAX_RECOVERY_STEPS
      }, 'Adjusted concurrency in recovery mode');
      
      return { concurrency: currentConcurrency };
    }
    
    return null;
  }

  // Enhanced adaptive scaling logic with predictive adjustment
  if (systemHealth > 0.3 && avgCpu < 1.5 && avgMem > 0.4 && avgBacklog > 5 && avgError < 0.07) {
    // Good conditions, increase concurrency more aggressively based on stability
    consecutiveDecreaseTriggers = 0;
    stabilityCounter++;
    
    // Determine increase amount based on system stability, backlog and prediction
    let increaseAmount = 1; // Default conservative increase
    
    // More aggressive scaling when system is stable and backlog is high
    if (stabilityCounter > CONCURRENCY_STABILITY_THRESHOLD && avgBacklog > 20) {
      increaseAmount = Math.min(CONCURRENCY_INCREASE_RATE, Math.floor(avgBacklog / 10));
    }
    
    // Add predictive adjustment if positive
    if (predictiveAdjustment > 0) {
      increaseAmount = Math.max(increaseAmount, predictiveAdjustment);
    }
    
    const newConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + increaseAmount);
    
    if (newConcurrency > currentConcurrency) {
      currentConcurrency = newConcurrency;
      lastConcurrencyChange = now;
      logger.info({ 
        currentConcurrency, 
        increaseAmount, 
        predictiveComponent: predictiveAdjustment > 0 ? predictiveAdjustment : 0,
        systemHealth: systemHealth.toFixed(2),
        stabilityCounter 
      }, 'Increased concurrency');
      
      return { concurrency: currentConcurrency };
    }
  } else if (systemHealth < -0.3 || avgCpu > 2 || avgMem < 0.2 || avgError > 0.1 || avgResponseTime > lastAvgResponseTime * 1.5) {
    // Poor conditions, decrease concurrency with backoff strategy
    consecutiveDecreaseTriggers++;
    stabilityCounter = 0;
    
    // Calculate decrease step based on system health severity
    let severityMultiplier = 1;
    if (systemHealth < -0.6) severityMultiplier = 2;
    if (avgError > 0.2) severityMultiplier = 3; // Errors are high priority
    
    let decreaseStep = Math.min(
      consecutiveDecreaseTriggers, 
      MAX_DECREASE_STEP * severityMultiplier
    );
    
    // Add predictive adjustment if negative
    if (predictiveAdjustment < 0) {
      decreaseStep = Math.max(decreaseStep, Math.abs(predictiveAdjustment));
    }
    
    let newConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - decreaseStep);
    
    if (newConcurrency < currentConcurrency) {
      currentConcurrency = newConcurrency;
      lastConcurrencyChange = now;
      logger.info({ 
        currentConcurrency, 
        decreaseStep, 
        predictiveComponent: predictiveAdjustment < 0 ? predictiveAdjustment : 0,
        systemHealth: systemHealth.toFixed(2),
        severityMultiplier 
      }, 'Decreased concurrency with backoff');
      
      return { concurrency: currentConcurrency };
    }
  } else {
    // Stable system, maintain concurrency but adjust counter
    if (systemHealth > 0) {
      // Slightly positive conditions, increment stability
      stabilityCounter = Math.min(stabilityCounter + 1, CONCURRENCY_STABILITY_THRESHOLD);
    } else {
      // Slightly negative conditions, reduce stability
      stabilityCounter = Math.max(0, stabilityCounter - 1);
    }
    consecutiveDecreaseTriggers = Math.max(0, consecutiveDecreaseTriggers - 1);
    
    // Apply small predictive adjustments during stable periods if significant
    if (Math.abs(predictiveAdjustment) >= 2 && now - lastConcurrencyChange > COOLDOWN_MS * 2) {
      const newConcurrency = Math.max(
        MIN_CONCURRENCY, 
        Math.min(
          MAX_CONCURRENCY, 
          currentConcurrency + predictiveAdjustment
        )
      );
      
      if (newConcurrency != currentConcurrency) {
        currentConcurrency = newConcurrency;
        lastConcurrencyChange = now;
        logger.info({
          currentConcurrency,
          adjustment: predictiveAdjustment,
          reason: 'PREDICTIVE'
        }, 'Applied predictive concurrency adjustment');
        
        return { concurrency: currentConcurrency };
      }
    }
  }
  
  return null;
}

/**
 * Get current concurrency settings and status
 * @returns {Object} - Concurrency status object
 */
export function getConcurrencyStatus() {
  return {
    currentConcurrency,
    minConcurrency: MIN_CONCURRENCY,
    maxConcurrency: MAX_CONCURRENCY,
    stabilityCounter,
    circuitBreakerTripped,
    inRecoveryMode,
    recoveryProgress: inRecoveryMode ? 
      { current: recoveryStepsTaken, max: MAX_RECOVERY_STEPS } : null,
    predictedAdjustment: predictedConcurrencyAdjustment,
    lastChanged: new Date(lastConcurrencyChange).toISOString(),
    patterns: dailyConcurrencyPatterns,
    timestamp: Date.now()
  };
} 