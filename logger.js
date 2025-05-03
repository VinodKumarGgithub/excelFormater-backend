import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';
import redis from './redis.js';

const LOG_DIR = './logs';

// Configure logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  }
});

// Helper to ensure log directory exists
async function ensureLogDir() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err }, `Failed to create log directory "${LOG_DIR}"`);
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
  'PROGRESS': 'info'
};

// Refactored logging utility for clean, structured logs
const log = async ({ sessionId, batchId, requestId, jobId, type, message, meta = {} }) => {
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
  logger[logLevel](entry);

  // Store in Redis
  if (sessionId) {
    try {
      await redis.rpush(`logs:${sessionId}`, JSON.stringify(entry));
      await redis.expire(`logs:${sessionId}`, 86400); // Expire logs after 24 hours
    } catch (err) {
      logger.error({ err }, 'Failed to write to Redis');
    }
  }

  // Write to file
  const safeSessionId = sessionId?.replace(/[<>:"/\\|?*\s]/g, '_') || 'general';
  const logPath = path.join(LOG_DIR, `${safeSessionId}.log`);
  try {
    await ensureLogDir();
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.error({ err }, 'Failed to write log file');
  }
};

// Add info and error helpers for event handlers
log.info = (entry) => logger.info(entry);
log.error = (entry) => logger.error(entry);

export { log, logger }; 