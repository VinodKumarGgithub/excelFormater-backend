/**
 * Concurrency management constants
 */

// Core concurrency limits
export const MIN_CONCURRENCY = 20;
export const MAX_CONCURRENCY = 50;
export const COOLDOWN_MS = 30000; // 30 seconds cooldown between changes
export const MAX_DECREASE_STEP = 3;

// Enhanced concurrency management
export const CONCURRENCY_STABILITY_THRESHOLD = 5; // How many stable cycles before allowing aggressive increases
export const CONCURRENCY_INCREASE_RATE = 2; // How much to increase in good conditions
export const TREND_THRESHOLD = 3; // How many consistent measurements to establish a trend

// History tracking constants
export const HISTORY_LENGTH = 5;
export const TREND_HISTORY_LENGTH = 3;
export const SYSTEM_HEALTH_HISTORY = 10;

// Circuit breaker configuration
export const CIRCUIT_BREAKER_ERROR_THRESHOLD = 0.3; // 30% error rate triggers circuit breaker
export const CIRCUIT_BREAKER_RESET_TIMEOUT = 60000; // 1 minute cooldown before retry

// Auto-recovery settings
export const RECOVERY_MODE_STEP = 0.1; // Incremental recovery steps (% of max concurrency)
export const MAX_RECOVERY_STEPS = 5;

// Predictive scaling
export const PREDICTION_UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes 