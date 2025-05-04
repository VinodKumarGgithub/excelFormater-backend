import { Worker } from 'bullmq';
import os from 'os';

// Import from new modular structure
import redis from './lib/config/redisConfig.js';
import { log, logger } from './lib/services/loggerService.js';

// Import constants
import {
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  COOLDOWN_MS,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT
} from './lib/constants/concurrency.js';

// Import helpers and services
import { validateJobData } from './lib/helpers/validation.js';
import { createAuthHeaders } from './lib/helpers/auth.js';
import { processRecord } from './lib/services/processRecord.js';
import { getQueueBacklog } from './lib/services/queueManager.js';
import { getApiErrorRate } from './lib/helpers/metrics.js';
import { getConcurrencyStatus } from './lib/services/concurrencyManager.js';

// Allow self-signed certificates in development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Current worker instance
let workerInstance = null;
let currentConcurrency = MIN_CONCURRENCY;
const WORKER_ID = process.env.WORKER_ID || Math.random().toString(36).slice(2, 10);

/**
 * Create a worker with the specified concurrency
 * @param {number} concurrency - Number of concurrent jobs
 */
function createWorker(concurrency) {
  if (workerInstance) {
    workerInstance.close();
  }
  
  // Get concurrency status for logging
  const concurrencyStatus = getConcurrencyStatus();
  
  logger.info({ 
    concurrency, 
    status: concurrencyStatus
  }, 'Creating worker instance');
  
  workerInstance = new Worker(
  'batchQueue',
  async (job) => {
    const { sessionId, records, verbose = false } = job.data;
    const jobId = job.id;
    let successCount = 0;
    let failureCount = 0;

    // Validate job data
      validateJobData(records);

    const configJson = await redis.get(sessionId);
    if (!configJson) {
      throw new Error(`No config found for sessionId: ${sessionId}`);
    }

    const { apiUrl, auth } = JSON.parse(configJson);
      const headers = createAuthHeaders(auth);

    await log({
      sessionId,
      jobId,
      type: 'START',
      message: `Processing batch of ${records.length} records`,
      meta: { totalRecords: records.length }
    });

    // Process records with progress tracking
      let startTime = Date.now();
      const startedAt = new Date(startTime).toISOString();
      await log({
        sessionId,
        jobId,
        type: 'JOB_STARTED',
        message: 'Job started',
        meta: {
          totalRecords: records.length,
          startedAt
        }
      });
      
      let processedCount = 0;
      let totalProcessingTime = 0;
    for (let i = 0; i < records.length; i++) {
        const recordStart = Date.now();
      try {
        await processRecord(records[i], apiUrl, headers, sessionId, jobId, i, records.length);
        successCount++;
      } catch (err) {
        failureCount++;
      }
        const recordEnd = Date.now();
        processedCount++;
        totalProcessingTime += (recordEnd - recordStart);

        // Calculate ETA
        const avgTimePerRecord = processedCount > 0 ? totalProcessingTime / processedCount : 0;
        const recordsLeft = records.length - (i + 1);
        const estTimeLeftMs = avgTimePerRecord * recordsLeft / currentConcurrency;
        const estTimeLeftSec = Math.round(estTimeLeftMs / 1000);

        // Get global metrics for graphing
        const backlog = await getQueueBacklog();
        const concurrencyStatus = getConcurrencyStatus();

        // Maintain a short history for graphing
        if (!global.progressHistory) global.progressHistory = [];
        global.progressHistory.push({
          timestamp: Date.now(),
          completed: i + 1,
          total: records.length,
          avgTimePerRecordMs: Math.round(avgTimePerRecord),
          estTimeLeftSec,
          currentConcurrency,
          backlog,
          successCount,
          failureCount,
          ...concurrencyStatus
        });
        if (global.progressHistory.length > 20) global.progressHistory.shift();

      // Update progress
      if (i % 5 === 0 || i === records.length - 1) {
        await job.updateProgress({
          completed: i + 1,
          total: records.length,
          successCount,
            failureCount,
            meta: {
              avgTimePerRecordMs: Math.round(avgTimePerRecord),
              estTimeLeftSec,
              currentConcurrency,
              backlog,
              ...concurrencyStatus
            }
          });
          
          // Log batch progress
          await log({
            sessionId,
            jobId,
            type: 'PROGRESS',
            message: `Batch progress: ${i + 1}/${records.length}`,
            meta: {
              successCount,
              failureCount,
              avgTimePerRecordMs: Math.round(avgTimePerRecord),
              estTimeLeftSec,
              currentConcurrency,
              backlog,
              ...concurrencyStatus
            }
          });
          
          // Store global metrics in Redis
          const globalMetrics = {
            workerId: WORKER_ID,
            currentConcurrency,
            avgTimePerRecordMs: Math.round(avgTimePerRecord),
            estTimeLeftSec,
            successCount,
            failureCount,
            total: records.length,
            completed: i + 1,
            backlog,
            ...concurrencyStatus,
            progressHistory: global.progressHistory,
            timestamp: Date.now()
          };
          await redis.set(`worker:globalMetrics:${WORKER_ID}`, JSON.stringify(globalMetrics));
      }
    }

    // Store job metrics
    await redis.hset(`metrics:${jobId}`, {
      successCount,
      failureCount,
      totalRecords: records.length,
      completedAt: new Date().toISOString()
    });

      await log({
        sessionId,
        jobId,
        type: 'COMPLETE',
        message: `Batch processing complete`,
        meta: { successCount, failureCount, totalRecords: records.length }
      });

      // Log job completed with timing and stats
      const completedAt = new Date().toISOString();
      await log({
        sessionId,
        jobId,
        type: 'JOB_COMPLETED',
        message: 'Job completed',
        meta: {
          totalRecords: records.length,
          successCount,
          failureCount,
          startedAt,
          completedAt,
          durationSec: Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
        }
      });

    return {
      successCount,
      failureCount,
      totalRecords: records.length
    };
  },
  {
      concurrency,
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
  workerInstance.on('completed', async (job) => {
  const { successCount, failureCount, totalRecords } = job.returnvalue;
  logger.info({
    jobId: job.id,
    successCount,
    failureCount,
    totalRecords
  }, 'Job completed');
});

  workerInstance.on('failed', async (job, err) => {
  logger.error({
    jobId: job.id,
    error: err.message,
    stack: err.stack
  }, 'Job failed');
});

  workerInstance.on('progress', (job, progress) => {
  logger.info({
    jobId: job.id,
    ...progress
  }, 'Job progress update');
});

  logger.info({ concurrency }, 'Worker started with concurrency');
}

/**
 * Start the worker with concurrency monitoring
 */
function startWorker() {
  // Create initial worker
  createWorker(currentConcurrency);
  
  // Import the monitor function dynamically to avoid circular dependencies
  import('./lib/services/concurrencyManager.js')
    .then(({ monitorAndAdjustConcurrency }) => {
      // Set up periodic concurrency monitoring
      setInterval(async () => {
        const workerUpdate = await monitorAndAdjustConcurrency();
        if (workerUpdate) {
          currentConcurrency = workerUpdate.concurrency;
          createWorker(currentConcurrency);
        }
      }, COOLDOWN_MS);
    })
    .catch(err => {
      logger.error({ error: err.message }, 'Failed to import concurrency monitor');
    });
}

// Start the worker
startWorker();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down worker...');
  if (workerInstance) await workerInstance.close();
  process.exit(0);
});
