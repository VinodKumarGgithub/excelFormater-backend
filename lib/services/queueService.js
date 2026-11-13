import { Queue } from 'bullmq';
import redis from '../config/redisConfig.js';
import { QUEUE } from '../config/appConfig.js';
import { logger } from './loggerService.js';

// Create singleton Queue instance
let batchQueueInstance = null;

export const getBatchQueue = () => {
  if (!batchQueueInstance) {
    logger.info('Initializing Batch Queue');
    batchQueueInstance = new Queue('batchQueue', { 
      connection: redis,
      defaultJobOptions: QUEUE.DEFAULT_JOB_OPTIONS
    });
  }
  return batchQueueInstance;
};
