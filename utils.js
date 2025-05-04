/**
 * @deprecated Use the specific modules from lib/ directly
 * This file is maintained for backward compatibility 
 * and will be removed in future versions.
 */

// Re-export from helpers
export { validateJobData } from './lib/helpers/validation.js';
export { createAuthHeaders } from './lib/helpers/auth.js';
export { 
  getApiErrorRate,
  trackApiErrorRate,
  movingAverage,
  detectTrend,
  getHourFromTimestamp
} from './lib/helpers/metrics.js';

// Re-export from services
export { processRecord } from './lib/services/processRecord.js';
export { getQueueBacklog } from './lib/services/queueManager.js';
export { getApiRateLimitStatus } from './lib/services/rateLimit.js';
export { trackApiResponseMetrics, trackEndpointPerformance } from './lib/services/apiClient.js';

// Log a deprecation warning
import { logger } from './lib/services/loggerService.js';
logger.warn('utils.js is deprecated. Please import from lib/ modules directly.'); 