import { Worker } from 'bullmq';
import axios from 'axios';
import fs from 'fs/promises';
import redis from './redis.js';
import path from 'path';

const LOG_DIR = './logs';
await fs.mkdir(LOG_DIR, { recursive: true });

const log = async ({ sessionId, jobId, type, message, meta = {} }) => {
  const timestamp = new Date().toISOString();
  const entry = {
    time: timestamp,
    jobId,
    type,
    message,
    ...meta,
  };
  const stringified = JSON.stringify(entry);

  console.log(stringified); // Dev log

  // Write to Redis
  if (sessionId) {
    try {
      await redis.rpush(`logs:${sessionId}`, stringified);
    } catch (err) {
      console.error(`Failed to write to Redis: ${err.message}`);
    }
  }

  // Write to file
  try {
    const logPath = path.join(LOG_DIR, `${sessionId || 'general'}.log`);
    await fs.appendFile(logPath, stringified + '\n');
  } catch (err) {
    console.error(`Failed to write log file: ${err.message}`);
  }
};

const newWorker = new Worker(
  'batchQueue',
  async (job) => {
    const { sessionId, records } = job.data;
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
        const response = await axios.post(apiUrl, record, { headers });

        await log({
          sessionId,
          jobId,
          type: 'SUCCESS',
          message: `Sent record ${i + 1}/${records.length}`,
          meta: { status: response.status },
        });

        await job.updateProgress(((i + 1) / records.length) * 100);
      } catch (err) {
        const errorMessage = err.response?.headers?.['response-description'] || err.message;

        await log({
          sessionId,
          jobId,
          type: 'ERROR',
          message: `Error on record ${i + 1}`,
          meta: { error: errorMessage, payload: record },
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
  { concurrency: 4 }
);
