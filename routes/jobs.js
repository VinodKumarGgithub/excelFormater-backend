import express from 'express';
import { Queue } from 'bullmq';
import redis from '../lib/redis.js';
import { authenticateJWT } from './sessions.js';

const batchQueue = new Queue('batchQueue', { connection: redis });
const router = express.Router();

router.use(authenticateJWT);

// POST /api/queue-batch
router.post('/queue-batch', async (req, res) => {
  const { sessionId, records } = req.body;
  if (!sessionId || !records) return res.status(400).json({ success: false, message: 'Missing data' });
  await batchQueue.add(`processBatch-${sessionId}`, { sessionId, records });
  res.json({ success: true, message: 'Batch queued successfully' });
});

export default router; 