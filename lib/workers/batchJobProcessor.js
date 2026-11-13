import redis from '../config/redisConfig.js';
import { log, logger } from '../services/loggerService.js';
import { validateJobData } from '../helpers/validation.js';
import { createAuthHeaders } from '../helpers/auth.js';
import { processRecord, batchProcessRecords } from '../services/processRecord.js';
import workerPool from '../services/workerPool.js';
import { updateJobProgress } from '../services/progressTracker.js';
import Session from '../models/Session.js';

export async function processBatchJob(job, currentConcurrency, workerId) {
  const { sessionId, records, verbose = false } = job.data;
  const jobId = job.id;
  let successCount = 0;
  let failureCount = 0;

  // Validate job data
  validateJobData(records);

  // Read session config from DB first, fallback to Redis
  let apiUrl, auth;
  const dbSession = await Session.findByPk(sessionId);
  if (dbSession) {
    apiUrl = dbSession.apiUrl || dbSession.sessionConfig?.apiUrl;
    auth = {
      type: 'basic',
      username: dbSession.authUsername,
      password: dbSession.authPassword
    };
    // Also pull from sessionConfig JSON if auth fields aren't set directly
    if (!auth.username && dbSession.sessionConfig?.auth) {
      auth = dbSession.sessionConfig.auth;
    }
  } else {
    // Fallback to Redis for backward compatibility
    const configJson = await redis.get(sessionId);
    if (!configJson) {
      throw new Error(`No config found for sessionId: ${sessionId} (checked DB and Redis)`);
    }
    const config = JSON.parse(configJson);
    apiUrl = config.apiUrl;
    auth = config.auth;
  }

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

  // DB Sync: Status Change
  try {
    await Session.update(
      { status: 'PROCESSING', startedAt: new Date(startTime) },
      { where: { sessionId } }
    );
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to flip Session status to PROCESSING natively inside DB');
  }
  
  // Initialize worker pool if needed
  if (!workerPool.initialized) {
    await workerPool.initialize();
    logger.info('Worker pool initialized for batch processing');
  }
  
  // Use batch processing with worker pool for improved performance
  try {
    const BATCH_SIZE = 10;
    let processedCount = 0;
    let totalProcessingTime = 0;
    
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batchStart = Date.now();
      const batchRecords = records.slice(i, i + BATCH_SIZE);
      
      const batchResult = await batchProcessRecords(
        batchRecords, 
        apiUrl, 
        headers, 
        sessionId, 
        jobId
      );
      
      successCount += batchResult.summary.successCount;
      failureCount += batchResult.summary.failureCount;
      
      const batchEnd = Date.now();
      processedCount += batchRecords.length;
      totalProcessingTime += (batchEnd - batchStart);
      
      await updateJobProgress({
        job,
        processedCount,
        totalRecords: records.length,
        totalProcessingTime,
        currentConcurrency,
        successCount,
        failureCount,
        sessionId,
        jobId,
        workerId,
        isBatchLog: true
      });
    }
  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack
    }, 'Error in batch processing');
    
    logger.info('Falling back to individual record processing');
    
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

      const isBatchLog = (i % 5 === 0 || i === records.length - 1);
      
      await updateJobProgress({
        job,
        processedCount,
        totalRecords: records.length,
        totalProcessingTime,
        currentConcurrency,
        successCount,
        failureCount,
        sessionId,
        jobId,
        workerId,
        isBatchLog
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

  await log({
    sessionId,
    jobId,
    type: 'COMPLETE',
    message: `Batch processing complete`,
    meta: { successCount, failureCount, totalRecords: records.length }
  });

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

  // DB Sync: Final Analytics
  try {
    await Session.update(
      { 
        status: (failureCount === records.length && records.length > 0) ? 'FAILED' : 'COMPLETED',
        successCount, 
        errorCount: failureCount,
        completedAt: new Date()
      },
      { where: { sessionId } }
    );
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to persist final success/error counts and COMPLETED status to DB');
  }

  return {
    successCount,
    failureCount,
    totalRecords: records.length
  };
}
