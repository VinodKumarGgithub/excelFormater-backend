import { log } from './logger.js';
import Bottleneck from 'bottleneck';
import axios from 'axios';
import { Queue } from 'bullmq';
import redis from './redis.js';

// Configure rate limiter (should match worker.js settings)
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 100 // Minimum time between requests
});

// Configure axios instance with defaults (should match worker.js settings)
const api = axios.create({
  timeout: 10000,
  validateStatus: status => status < 500 // Retry only on 500+ errors
});

// Validate job data utility
export function validateJobData(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Invalid or empty records array');
  }
}

// Create headers for API auth
export function createAuthHeaders(auth) {
  return {
    Authorization: `Basic ${Buffer.from(`${auth.userId}:${auth.apiKey}`).toString('base64')}`,
    'X-User-Id': auth.userId,
  };
}

// Process single record with clean logging
export async function processRecord(record, apiUrl, headers, sessionId, jobId, recordIndex, totalRecords) {
  const maxRetries = 3;
  let attempt = 0;
  const batchId = record.memberId;
  const requestId = record.requestId;

  while (attempt < maxRetries) {
    try {
      // Log API request
      await log({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'API_REQUEST',
        message: `Sending API request for record ${recordIndex + 1}/${totalRecords}`,
        meta: { apiUrl, attempt: attempt + 1 }
      });

      // Use rate limiter for API calls
      const response = await limiter.schedule(() => 
        api.post(apiUrl, record, { headers })
      );

      // Log API response
      await log({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'API_RESPONSE',
        message: `Received API response for record ${recordIndex + 1}/${totalRecords}`,
        meta: {
          status: response.status,
          responseData: response.data,
          headers: response.headers
        }
      });

      // Log success
      await log({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: 'SUCCESS',
        message: `Processed record ${recordIndex + 1}/${totalRecords}`
      });

      return response;
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      const errorMessage = err.response?.headers?.['response-description'] || err.message;

      await log({
        sessionId,
        jobId,
        batchId,
        requestId,
        type: isLastAttempt ? 'ERROR' : 'WARN',
        message: `Attempt ${attempt}/${maxRetries} failed for record ${recordIndex + 1}`,
        meta: {
          error: errorMessage,
          status: err.response?.status,
          willRetry: !isLastAttempt
        }
      });

      if (isLastAttempt) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

// Utility to get queue backlog (waiting jobs)
const batchQueue = new Queue('batchQueue', { connection: redis });
export async function getQueueBacklog() {
  return batchQueue.getJobCountByTypes('waiting');
}

// In-memory API error tracking (for demo; use Redis for distributed)
let apiErrorTimestamps = [];
const ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function trackApiErrorRate(isError) {
  const now = Date.now();
  // Remove old errors
  apiErrorTimestamps = apiErrorTimestamps.filter(ts => now - ts < ERROR_WINDOW_MS);
  if (isError) apiErrorTimestamps.push(now);
}

export function getApiErrorRate() {
  const now = Date.now();
  apiErrorTimestamps = apiErrorTimestamps.filter(ts => now - ts < ERROR_WINDOW_MS);
  // For demo: error rate = errors per minute
  return apiErrorTimestamps.length / (ERROR_WINDOW_MS / 60000);
}

// Stub for API rate limit status (extend as needed)
export function getApiRateLimitStatus() {
  return false; // Implement real check if API provides rate limit info
} 