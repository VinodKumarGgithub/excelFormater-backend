/**
 * Queue management service - provides queue monitoring and management
 */
import { Queue } from 'bullmq';
import redis from '../config/redisConfig.js';
import { logger } from '../services/loggerService.js';

// Initialize queue
export const batchQueue = new Queue('batchQueue', { connection: redis });

/**
 * Get queue backlog count
 * @returns {Promise<number>} - Number of waiting jobs
 */
export async function getQueueBacklog() {
  try {
    // Get counts by job state
    const waiting = await batchQueue.getJobCountByTypes('waiting');
    const active = await batchQueue.getJobCountByTypes('active');
    const delayed = await batchQueue.getJobCountByTypes('delayed');
    
    // Store more detailed metrics in Redis
    redis.hset('metrics:queue', {
      waiting,
      active, 
      delayed,
      total: waiting + active + delayed,
      timestamp: Date.now()
    });
    
    return waiting;
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get queue backlog');
    return 0;
  }
}

/**
 * Add a job to the queue
 * @param {string} sessionId - Session ID
 * @param {Array} records - Records to process
 * @param {Object} options - Queue options
 * @returns {Promise<Job>} - Created job
 */
export async function addBatchJob(sessionId, records, options = {}) {
  try {
    const defaultOptions = {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000, // Keep the latest 1000 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600 // Keep failed jobs for 7 days
      }
    };
    
    const job = await batchQueue.add(
      'batch', 
      { sessionId, records }, 
      { ...defaultOptions, ...options }
    );
    
    logger.info({ jobId: job.id, sessionId, records: records.length }, 'Added batch job to queue');
    
    return job;
  } catch (err) {
    logger.error({ error: err.message, sessionId }, 'Failed to add batch job to queue');
    throw err;
  }
}

/**
 * Get queue statistics
 * @returns {Promise<Object>} - Queue statistics
 */
export async function getQueueStats() {
  try {
    const waiting = await batchQueue.getJobCountByTypes('waiting');
    const active = await batchQueue.getJobCountByTypes('active');
    const completed = await batchQueue.getJobCountByTypes('completed');
    const failed = await batchQueue.getJobCountByTypes('failed');
    const delayed = await batchQueue.getJobCountByTypes('delayed');
    
    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
      timestamp: Date.now()
    };
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get queue stats');
    throw err;
  }
} 