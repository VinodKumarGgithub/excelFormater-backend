import { Worker, Job } from 'bullmq';
import axios from 'axios';
import fs from 'fs/promises';
import redis from './redis.js';
import path from 'path';
import Bottleneck from 'bottleneck';
import pino from 'pino';

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

const LOG_DIR = './logs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Configure rate limiter
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 100 // Minimum time between requests
});

// Configure axios instance with defaults
const api = axios.create({
  timeout: 10000,
  validateStatus: status => status < 500 // Retry only on 500+ errors
});

// Create log directory
try {
  await fs.mkdir(LOG_DIR, { recursive: true });
} catch (err) {
  logger.error({ err }, `Failed to create log directory "${LOG_DIR}"`);
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
  'API_ERROR': 'error'
};

// Enhanced logging function with structured logging
const log = async ({ sessionId, jobId, type, message, meta = {} }) => {
  const timestamp = new Date().toISOString();
  const entry = { time: timestamp, jobId, type, message, ...meta };
  
  // Log to console with pino using the correct log level
  const logLevel = LOG_LEVEL_MAP[type] || 'info';
  logger[logLevel]({ sessionId, ...entry });

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
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.error({ err }, 'Failed to write log file');
  }
};

// Process single record with retries
async function processRecord(record, apiUrl, headers, sessionId, jobId, recordIndex, totalRecords) {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      // Use rate limiter for API calls
      const response = await limiter.schedule(() => 
        api.post(apiUrl, record, { headers })
      );

      await log({
        sessionId,
        jobId,
        type: 'SUCCESS',
        message: `Processed record ${recordIndex + 1}/${totalRecords}`,
        meta: { 
          status: response.status,
          attempt: attempt + 1,
          recordId: record.id,
          batchId: record.memberId
        }
      });

      return response;
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      const errorMessage = err.response?.headers?.['response-description'] || err.message;
      
      await log({
        sessionId,
        jobId,
        type: isLastAttempt ? 'ERROR' : 'WARN',
        message: `Attempt ${attempt}/${maxRetries} failed for record ${recordIndex + 1}`,
        meta: {
          error: errorMessage,
          payload: record,
          status: err.response?.status,
          willRetry: !isLastAttempt
        }
      });

      if (isLastAttempt) throw err;
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

// Enhanced worker with better error handling and monitoring
const newWorker = new Worker(
  'batchQueue',
  async (job) => {
    const { sessionId, records, verbose = false } = job.data;
    const jobId = job.id;
    let successCount = 0;
    let failureCount = 0;

    // Validate job data
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('Invalid or empty records array');
    }

    const configJson = await redis.get(sessionId);
    if (!configJson) {
      throw new Error(`No config found for sessionId: ${sessionId}`);
    }

    const { apiUrl, auth } = JSON.parse(configJson);
    const headers = {
      Authorization: `Basic ${Buffer.from(`${auth.userId}:${auth.apiKey}`).toString('base64')}`,
      'X-User-Id': auth.userId,
    };

    await log({
      sessionId,
      jobId,
      type: 'START',
      message: `Processing batch of ${records.length} records`,
      meta: { totalRecords: records.length }
    });

    // Process records with progress tracking
    for (let i = 0; i < records.length; i++) {
      try {
        await processRecord(records[i], apiUrl, headers, sessionId, jobId, i, records.length);
        successCount++;
      } catch (err) {
        failureCount++;
      }

      // Update progress
      if (i % 5 === 0 || i === records.length - 1) {
        await job.updateProgress({
          completed: i + 1,
          total: records.length,
          successCount,
          failureCount
        });
      }
    }

    // Store job metrics
    await redis.hset(`metrics:${jobId}`, {
      successCount,
      failureCount,
      totalRecords: records.length,
      completedAt: new Date().toISOString()
    });

    return {
      successCount,
      failureCount,
      totalRecords: records.length
    };
  },
  {
    concurrency: 20,
    limiter: {
      max: 1000,
      duration: 5000
    },
    settings: {
      retryProcessDelay: 5000,
      backoffDelay: 5000
    }
  }
);

// Enhanced event handlers
newWorker.on('completed', async (job) => {
  const { successCount, failureCount, totalRecords } = job.returnvalue;
  logger.info({
    jobId: job.id,
    successCount,
    failureCount,
    totalRecords
  }, 'Job completed');
});

newWorker.on('failed', async (job, err) => {
  logger.error({
    jobId: job.id,
    error: err.message,
    stack: err.stack
  }, 'Job failed');
});

newWorker.on('progress', (job, progress) => {
  logger.info({
    jobId: job.id,
    ...progress
  }, 'Job progress update');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down worker...');
  await newWorker.close();
  process.exit(0);
});
