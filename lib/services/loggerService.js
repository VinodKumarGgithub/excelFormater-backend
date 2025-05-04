/**
 * Logger service - provides structured logging functionality
 */
import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';
import redis from '../config/redisConfig.js';

// Log directory configuration
const LOG_DIR = './logs';

// Configure Pino logger
const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  }
});

/**
 * Ensure log directory exists before writing
 * @returns {Promise<void>}
 */
async function ensureLogDir() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    pinoLogger.error({ err }, `Failed to create log directory "${LOG_DIR}"`);
  }
}

// Map log types to pino log levels
const LOG_LEVEL_MAP = {
  'ERROR': 'error',
  'WARN': 'warn',
  'INFO': 'info',
  'START': 'info',
  'SUCCESS': 'info',
  'COMPLETE': 'info',
  'API_REQUEST': 'debug',
  'API_RESPONSE': 'debug',
  'API_ERROR': 'error',
  'PROGRESS': 'info',
  'JOB_STARTED': 'info',
  'JOB_COMPLETED': 'info',
  'API_CALL': 'debug'
};

/**
 * Structured logging utility
 * @param {Object} options - Log options
 * @param {string} [options.sessionId] - Session ID
 * @param {string} [options.batchId] - Batch ID
 * @param {string} [options.requestId] - Request ID
 * @param {string} [options.jobId] - Job ID
 * @param {string} options.type - Log type (ERROR, WARN, INFO, etc.)
 * @param {string} options.message - Log message
 * @param {Object} [options.meta] - Additional metadata
 * @returns {Promise<void>}
 */
export async function log({ sessionId, batchId, requestId, jobId, type, message, meta = {} }) {
  const timestamp = new Date().toISOString();
  const entry = {
    time: timestamp,
    sessionId,
    batchId,
    requestId,
    type,
    message,
    ...meta,
    jobId
  };

  // Remove undefined fields for cleanliness
  Object.keys(entry).forEach(key => entry[key] === undefined && delete entry[key]);

  // Log to console with pino
  const logLevel = LOG_LEVEL_MAP[type] || 'info';
  pinoLogger[logLevel](entry);

  // Store in Redis for persistence and API access
  if (sessionId) {
    try {
      await redis.rpush(`logs:${sessionId}`, JSON.stringify(entry));
      await redis.expire(`logs:${sessionId}`, 86400); // Expire logs after 24 hours
    } catch (err) {
      pinoLogger.error({ err }, 'Failed to write to Redis');
    }
  }

  // Write to log file
  const safeSessionId = sessionId?.replace(/[<>:"/\\|?*\s]/g, '_') || 'general';
  const logPath = path.join(LOG_DIR, `${safeSessionId}.log`);
  try {
    await ensureLogDir();
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    pinoLogger.error({ err }, 'Failed to write log file');
  }
}

// Helper methods for simpler logging
log.info = (obj, msg = '') => {
  if (typeof obj === 'string') {
    pinoLogger.info(msg || obj);
  } else {
    pinoLogger.info(obj, msg);
  }
};

log.warn = (obj, msg = '') => {
  if (typeof obj === 'string') {
    pinoLogger.warn(msg || obj);
  } else {
    pinoLogger.warn(obj, msg);
  }
};

log.error = (obj, msg = '') => {
  if (typeof obj === 'string') {
    pinoLogger.error(msg || obj);
  } else {
    pinoLogger.error(obj, msg);
  }
};

log.debug = (obj, msg = '') => {
  if (typeof obj === 'string') {
    pinoLogger.debug(msg || obj);
  } else {
    pinoLogger.debug(obj, msg);
  }
};

// Export both the structured log function and the raw pino logger
export { pinoLogger as logger }; 