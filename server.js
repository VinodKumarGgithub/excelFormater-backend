import express from 'express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
// import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';

import { ExpressAdapter } from '@bull-board/express';
import redis from './redis.js';
import cors from 'cors';

const app = express();
const port = 3000;
const batchQueue = new Queue('batchQueue', { connection: redis });

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(batchQueue)],
  serverAdapter,
});

app.use(cors());
app.use(express.json());
app.use('/admin/queues', serverAdapter.getRouter());

// New endpoint to get logs for a session
app.get('/api/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { start = 0, count = 50 } = req.query;
    
    // Get logs from Redis
    const logs = await redis.lrange(`logs:${sessionId}`, start, start + count - 1);
    
    // Parse and format logs
    const formattedLogs = logs.map(log => {
      try {
        return JSON.parse(log);
      } catch (e) {
        return { error: 'Invalid log entry', raw: log };
      }
    });

    res.json({
      sessionId,
      total: await redis.llen(`logs:${sessionId}`),
      start: parseInt(start),
      count: formattedLogs.length,
      logs: formattedLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all active session IDs
app.get('/api/sessions', async (req, res) => {
  try {
    const keys = await redis.keys('logs:*');
    const sessions = keys.map(key => key.replace('logs:', ''));
    
    // Get session info
    const sessionInfo = await Promise.all(
      sessions.map(async (sessionId) => {
        const logCount = await redis.llen(`logs:${sessionId}`);
        const ttl = await redis.ttl(`logs:${sessionId}`);
        return {
          sessionId,
          logCount,
          ttl
        };
      })
    );
    
    res.json(sessionInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get metrics for a job
app.get('/api/metrics/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const metrics = await redis.hgetall(`metrics:${jobId}`);
    res.json(metrics || { error: 'No metrics found for this job' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/init-session', async (req, res) => {
  const { apiUrl, auth } = req.body;
  if (!apiUrl || !auth) return res.status(400).json({ error: 'Missing data' });
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  await redis.set(sessionId, JSON.stringify({ apiUrl, auth }), 'EX', 3600);
  res.json({ sessionId });
});

app.post('/api/queue-batch', async (req, res) => {
  const { sessionId, records } = req.body;
  if (!sessionId || !records) return res.status(400).json({ error: 'Missing data' });
  await batchQueue.add('processBatch', { sessionId, records });
  res.json({ status: 'queued' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Bull Board at http://localhost:${port}/admin/queues`);
  console.log(`Logs API at http://localhost:${port}/api/logs/:sessionId`);
  console.log(`Sessions API at http://localhost:${port}/api/sessions`);
  console.log(`Metrics API at http://localhost:${port}/api/metrics/:jobId`);
});