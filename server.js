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
});