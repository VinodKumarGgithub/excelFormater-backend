/**
 * Worker entry point — creates a BullMQ worker with auto-scaling
 * concurrency. All job processing is delegated to batchJobProcessor.
 */
import { Worker } from 'bullmq';

import redis from './lib/config/redisConfig.js';
import sequelize from './lib/config/db.js';
import { logger } from './lib/services/loggerService.js';

import {
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  COOLDOWN_MS,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT
} from './lib/constants/concurrency.js';

import { getQueueBacklog } from './lib/services/queueManager.js';
import { getApiErrorRate } from './lib/helpers/metrics.js';
import { getConcurrencyStatus } from './lib/services/concurrencyManager.js';
import workerPool from './lib/services/workerPool.js';
import { processBatchJob } from './lib/workers/batchJobProcessor.js';

// Allow self-signed certificates in development
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let workerInstance = null;
let currentConcurrency = MIN_CONCURRENCY;
const WORKER_ID = process.env.WORKER_ID || Math.random().toString(36).slice(2, 10);

/**
 * Create (or recreate) a BullMQ worker with the given concurrency.
 */
function createWorker(concurrency) {
  if (workerInstance) {
    workerInstance.close();
  }

  const concurrencyStatus = getConcurrencyStatus();
  logger.info({ concurrency, status: concurrencyStatus }, 'Creating worker instance');

  workerInstance = new Worker(
    'batchQueue',
    async (job) => processBatchJob(job, currentConcurrency, WORKER_ID),
    {
      concurrency,
      connection: redis,
      limiter: { max: 1000, duration: 5000 },
      settings: { retryProcessDelay: 5000, backoffDelay: 5000 }
    }
  );

  // --- Event handlers ---
  workerInstance.on('completed', async (job) => {
    const { successCount, failureCount, totalRecords } = job.returnvalue;
    logger.info({ jobId: job.id, successCount, failureCount, totalRecords }, 'Job completed');
  });

  workerInstance.on('failed', async (job, err) => {
    logger.error({ jobId: job.id, error: err.message, stack: err.stack }, 'Job failed');

    if (job?.data) {
      const { sessionId } = job.data;
      const { log } = await import('./lib/services/loggerService.js');
      await log({
        sessionId,
        jobId: job.id,
        type: 'JOB_FAILED',
        message: 'Job failed',
        meta: { error: err.message }
      });
    }
  });

  return workerInstance;
}

/**
 * Start the worker with dynamic auto-scaling.
 */
async function startWorker() {
  const autoScaleInterval = setInterval(async () => {
    try {
      const errorRate = getApiErrorRate();

      // Circuit breaker
      if (errorRate > CIRCUIT_BREAKER_ERROR_THRESHOLD) {
        logger.warn({
          errorRate,
          threshold: CIRCUIT_BREAKER_ERROR_THRESHOLD,
          timeout: CIRCUIT_BREAKER_RESET_TIMEOUT
        }, 'Circuit breaker activated');

        await redis.hset('metrics:circuitBreaker', {
          lastTripped: Date.now().toString(),
          reason: `Error rate (${errorRate}) exceeded threshold (${CIRCUIT_BREAKER_ERROR_THRESHOLD})`,
          resetTimeout: CIRCUIT_BREAKER_RESET_TIMEOUT.toString()
        });
      }

      // Auto-scaling based on queue backlog and API health
      const backlog = await getQueueBacklog();
      let newConcurrency = currentConcurrency;

      if (errorRate > 0.1) {
        newConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(currentConcurrency * 0.8));
      } else if (backlog > 10 && errorRate < 0.05 && currentConcurrency < MAX_CONCURRENCY) {
        newConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + 1);
      } else if (backlog < 3 && currentConcurrency > MIN_CONCURRENCY) {
        newConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - 1);
      }

      if (newConcurrency !== currentConcurrency) {
        logger.info({
          previousConcurrency: currentConcurrency,
          newConcurrency,
          backlog,
          errorRate
        }, 'Adjusting concurrency');

        currentConcurrency = newConcurrency;
        createWorker(currentConcurrency);
      }
    } catch (err) {
      logger.error({ error: err.message, stack: err.stack }, 'Error in worker auto-scaling');
    }
  }, 60000);

  // Create initial worker
  createWorker(currentConcurrency);

  // Start worker pool for API calls and authenticate DB
  try {
    await sequelize.authenticate();
    // Import models to register them with Sequelize before syncing
    await import('./lib/models/User.js');
    await import('./lib/models/Session.js');
    await import('./lib/models/ApiLog.js');
    await sequelize.sync({ alter: true });
    logger.info('Database authenticated and models synced inside worker');
    await workerPool.initialize();
  } catch (err) {
    logger.error({ error: err.message, stack: err.stack }, 'Failed to initialize worker or DB dependencies');
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down worker');
    clearInterval(autoScaleInterval);

    try {
      if (workerInstance) await workerInstance.close();
      await workerPool.shutdown();
      await sequelize.close();
      logger.info('Worker cleanly shutdown alongside DB sequence');
    } catch (err) {
      logger.error({ error: err.message, stack: err.stack }, 'Error during worker shutdown');
    } finally {
      process.exit(0);
    }
  });
}

startWorker();

export { startWorker };
