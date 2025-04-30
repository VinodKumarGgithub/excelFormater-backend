import { Worker } from 'bullmq';
import axios from 'axios';
import fs from 'fs/promises';
import redis from './redis.js';
import path from 'path';

const LOG_DIR = './logs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

try {
  await fs.mkdir(LOG_DIR, { recursive: true });
} catch (err) {
  console.error(`Failed to create log directory "${LOG_DIR}": ${err.message}`);
}

const log = async ({ sessionId, jobId, type, message, meta = {} }) => {
  const timestamp = new Date().toISOString();
  const entry = { time: timestamp, jobId, type, message, ...meta };
  const stringified = JSON.stringify(entry);

  if (sessionId) {
    try {
      await redis.rpush(`logs:${sessionId}`, stringified);
    } catch (err) {
      console.error(`Failed to write to Redis: ${err.message}`);
    }
  }

  const safeSessionId = sessionId?.replace(/[<>:"/\\|?*\s]/g, '_') || 'general';
  const logPath = path.join(LOG_DIR, `${safeSessionId}.log`);
  try {
    await fs.appendFile(logPath, stringified + '\n');
  } catch (err) {
    console.error(`Failed to write log file: ${err.message}`);
  }
};

const newWorker = new Worker(
  'batchQueue',
  async (job) => {
    const { sessionId, records, verbose = false } = job.data;
    const jobId = job.id;

    const configJson = await redis.get(sessionId);
    if (!configJson) {
      const msg = `No config found for sessionId: ${sessionId}`;
      await log({ sessionId, jobId, type: 'ERROR', message: msg });
      throw new Error(msg);
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
      message: `Job started for session: ${sessionId}`,
      meta: { totalRecords: records.length },
    });

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      try {
        if (verbose) {
          await log({
            sessionId,
            jobId,
            type: 'API_REQUEST',
            message: `Sending API request for record ${i + 1}`,
            meta: { record },
          });
        }

        const response = await axios.post(apiUrl, record, { headers });

        if (verbose) {
          await log({
            sessionId,
            jobId,
            type: 'API_RESPONSE',
            message: `Received response for record ${i + 1}`,
            meta: {
              status: response.status,
              data: response.data,
              headers: response.headers,
            },
          });
        }

        // Log every 10th record if not verbose
        if (verbose || i % 10 === 0 || i === records.length - 1) {
          await log({
            sessionId,
            jobId,
            type: 'SUCCESS',
            message: `Processed record ${i + 1}/${records.length}`,
            meta: { status: response.status },
          });
        }

        if (verbose || i % 5 === 0 || i === records.length - 1) {
          await job.updateProgress(((i + 1) / records.length) * 100);
        }

      } catch (err) {
        const errorMessage = err.response?.headers?.['response-description'] || err.message;
        await log({
          sessionId,
          jobId,
          type: 'API_ERROR',
          message: `Error on record ${i + 1}`,
          meta: {
            error: errorMessage,
            payload: record,
            stack: err.stack,
            status: err.response?.status,
            responseData: err.response?.data,
            responseHeaders: err.response?.headers,
          },
        });
      }
    }

    await log({
      sessionId,
      jobId,
      type: 'COMPLETE',
      message: `Job completed for session: ${sessionId}`,
    });
  },
  {
    concurrency: 4,
  }
);

newWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed!`);
});

newWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error: ${err.message}`);
});

newWorker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} is ${progress}% complete`);
});

newWorker.on('stalled', (job) => {
  console.log(`Job ${job.id} is stalled`);
});
