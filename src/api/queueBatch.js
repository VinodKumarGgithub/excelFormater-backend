import express from 'express';
import { batchQueue } from '../bull/queue.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { sessionId, records } = req.body;
  if (!sessionId || !records) return res.status(400).json({ error: 'Missing data' });
  await batchQueue.add('processBatch', { sessionId, records });
  res.json({ status: 'queued' });
});

export default router; 