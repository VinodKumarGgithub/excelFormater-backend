/**
 * Progress tracking service — calculates ETAs, stores global metrics 
 * in Redis, and maintains a rolling history for real-time graphing.
 */
import redis from '../config/redisConfig.js';
import { log, logger } from './loggerService.js';
import { getQueueBacklog } from './queueManager.js';
import { getConcurrencyStatus } from './concurrencyManager.js';

// Rolling history for charting (kept in-process per worker)
if (!global.progressHistory) global.progressHistory = [];
const MAX_HISTORY_SIZE = 20;

/**
 * Update and broadcast job progress after each batch/record completes.
 *
 * @param {Object} opts
 * @param {import('bullmq').Job} opts.job           - BullMQ job handle
 * @param {number}               opts.processedCount
 * @param {number}               opts.totalRecords
 * @param {number}               opts.totalProcessingTime - cumulative ms
 * @param {number}               opts.currentConcurrency
 * @param {number}               opts.successCount
 * @param {number}               opts.failureCount
 * @param {string}               opts.sessionId
 * @param {string}               opts.jobId
 * @param {string}               opts.workerId
 * @param {boolean}              opts.isBatchLog     - whether to emit a log line
 */
export async function updateJobProgress({
  job,
  processedCount,
  totalRecords,
  totalProcessingTime,
  currentConcurrency,
  successCount,
  failureCount,
  sessionId,
  jobId,
  workerId,
  isBatchLog = true
}) {
  const avgTimePerRecord = processedCount > 0 ? totalProcessingTime / processedCount : 0;
  const recordsLeft = totalRecords - processedCount;
  const estTimeLeftMs = currentConcurrency > 0
    ? (avgTimePerRecord * recordsLeft) / currentConcurrency
    : 0;
  const estTimeLeftSec = Math.round(estTimeLeftMs / 1000);

  // Queue / concurrency snapshot
  const backlog = await getQueueBacklog();
  const concurrencyStatus = getConcurrencyStatus();

  // Rolling history
  global.progressHistory.push({
    timestamp: Date.now(),
    completed: processedCount,
    total: totalRecords,
    avgTimePerRecordMs: Math.round(avgTimePerRecord),
    estTimeLeftSec,
    currentConcurrency,
    backlog,
    successCount,
    failureCount,
    ...concurrencyStatus
  });
  if (global.progressHistory.length > MAX_HISTORY_SIZE) {
    global.progressHistory.shift();
  }

  // BullMQ progress event (consumed by the frontend poller)
  await job.updateProgress({
    completed: processedCount,
    total: totalRecords,
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

  // Structured log line (only on batch boundaries to reduce noise)
  if (isBatchLog) {
    await log({
      sessionId,
      jobId,
      type: 'PROGRESS',
      message: `Batch progress: ${processedCount}/${totalRecords}`,
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
  }

  // Persist per-worker metrics in Redis for the dashboard
  const globalMetrics = {
    workerId,
    currentConcurrency,
    avgTimePerRecordMs: Math.round(avgTimePerRecord),
    estTimeLeftSec,
    successCount,
    failureCount,
    total: totalRecords,
    completed: processedCount,
    backlog,
    ...concurrencyStatus,
    progressHistory: global.progressHistory,
    timestamp: Date.now()
  };
  await redis.set(`worker:globalMetrics:${workerId}`, JSON.stringify(globalMetrics));
}
