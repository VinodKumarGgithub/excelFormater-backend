import { Worker, Job } from 'bullmq';
import axios from 'axios';
import fs from 'fs/promises';
import redis from './redis.js';
import path from 'path';
import Bottleneck from 'bottleneck';

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

      return response;
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      
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
});
// Graceful shutdown
process.on('SIGTERM', async () => {
  await newWorker.close();
  process.exit(0);
});
