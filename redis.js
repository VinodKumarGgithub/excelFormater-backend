/**
 * @deprecated Use lib/config/redisConfig.js instead
 * This file is maintained for backward compatibility 
 * and will be removed in future versions.
 */
import redis from './lib/config/redisConfig.js';
import { logger } from './lib/services/loggerService.js';

logger.warn('Direct import of redis.js is deprecated. Use lib/config/redisConfig.js instead.');

export default redis;
