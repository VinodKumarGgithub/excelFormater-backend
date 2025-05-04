/**
 * @deprecated Use lib/services/loggerService.js instead
 * This file is maintained for backward compatibility 
 * and will be removed in future versions.
 */
import { log, logger } from './lib/services/loggerService.js';

logger.warn('Direct import of logger.js is deprecated. Use lib/services/loggerService.js instead.');

export { log, logger }; 