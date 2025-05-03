import { Worker, Job } from 'bullmq';
import fs from 'fs/promises';
import redis from './redis.js';
import path from 'path';
import os from 'os';
import { log } from './logger.js';
import {
  processRecord,
  validateJobData,
  createAuthHeaders,
  getQueueBacklog,
  getApiErrorRate,
  getApiRateLimitStatus
} from './utils.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Dynamic concurrency management
const MIN_CONCURRENCY = 20;
const MAX_CONCURRENCY = 50;
let currentConcurrency = 5;
let workerInstance = null;
let lastConcurrencyChange = 0;
const COOLDOWN_MS = 60000; // 1 minute cooldown between changes
let consecutiveDecreaseTriggers = 0;
const MAX_DECREASE_STEP = 3;

// Helper for moving average
let cpuHistory = [];
let memHistory = [];
let errorRateHistory = [];
const HISTORY_LENGTH = 5;

function movingAverage(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function createWorker(concurrency) {
  if (workerInstance) {
    workerInstance.close();
  }
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
        const avgCpu = movingAverage(cpuHistory);
        const avgMem = movingAverage(memHistory);
        const avgError = movingAverage(errorRateHistory);

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
          avgCpu,
          avgMem,
          avgError,
          successCount,
          failureCount,
          consecutiveDecreaseTriggers
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
              avgCpu,
              avgMem,
              avgError,
              consecutiveDecreaseTriggers
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
              avgCpu,
              avgMem,
              avgError,
              consecutiveDecreaseTriggers
            }
          });
          // Store global metrics in Redis
          const globalMetrics = {
            currentConcurrency,
            avgTimePerRecordMs: Math.round(avgTimePerRecord),
            estTimeLeftSec,
            successCount,
            failureCount,
            total: records.length,
            completed: i + 1,
            backlog,
            avgCpu,
            avgMem,
            avgError,
            consecutiveDecreaseTriggers,
            progressHistory: global.progressHistory,
            timestamp: Date.now()
          };
          await redis.set('worker:globalMetrics', JSON.stringify(globalMetrics), 'EX', 60);
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
    log.info({
      jobId: job.id,
      successCount,
      failureCount,
      totalRecords
    }, 'Job completed');
  });

  workerInstance.on('failed', async (job, err) => {
    log.error({
      jobId: job.id,
      error: err.message,
      stack: err.stack
    }, 'Job failed');
  });

  workerInstance.on('progress', (job, progress) => {
    log.info({
      jobId: job.id,
      ...progress
    }, 'Job progress update');
  });

  log.info({ concurrency }, 'Worker started with concurrency');
}

async function monitorAndAdjustConcurrency() {
  setInterval(async () => {
    const now = Date.now();
    const cpu = os.loadavg()[0];
    const mem = os.freemem() / os.totalmem();
    const backlog = await getQueueBacklog();
    const apiErrorRate = getApiErrorRate();

    // Update histories
    cpuHistory.push(cpu); if (cpuHistory.length > HISTORY_LENGTH) cpuHistory.shift();
    memHistory.push(mem); if (memHistory.length > HISTORY_LENGTH) memHistory.shift();
    errorRateHistory.push(apiErrorRate); if (errorRateHistory.length > HISTORY_LENGTH) errorRateHistory.shift();

    const avgCpu = movingAverage(cpuHistory);
    const avgMem = movingAverage(memHistory);
    const avgError = movingAverage(errorRateHistory);

    log.info({
      avgCpu, avgMem, avgError, backlog, currentConcurrency, consecutiveDecreaseTriggers
    }, 'Resource metrics for concurrency tuning');

    // Cooldown logic
    if (now - lastConcurrencyChange < COOLDOWN_MS) return;

    // Enhanced logic
    if (avgCpu < 1 && avgMem > 0.5 && backlog > 10 && avgError < 0.05) {
      consecutiveDecreaseTriggers = 0;
      if (currentConcurrency < MAX_CONCURRENCY) {
        currentConcurrency++;
        createWorker(currentConcurrency);
        lastConcurrencyChange = now;
        log.info({ currentConcurrency }, 'Increased concurrency');
      }
    } else if (avgCpu > 2 || avgMem < 0.2 || avgError > 0.1) {
      consecutiveDecreaseTriggers++;
      let decreaseStep = Math.min(consecutiveDecreaseTriggers, MAX_DECREASE_STEP);
      let newConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - decreaseStep);
      if (newConcurrency < currentConcurrency) {
        currentConcurrency = newConcurrency;
        createWorker(currentConcurrency);
        lastConcurrencyChange = now;
        log.info({ currentConcurrency, decreaseStep }, 'Decreased concurrency with backoff');
      }
    } else {
      consecutiveDecreaseTriggers = 0;
    }
  }, 30000);
}

// On startup
createWorker(currentConcurrency);
monitorAndAdjustConcurrency();

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('Shutting down worker...');
  if (workerInstance) await workerInstance.close();
  process.exit(0);
});
