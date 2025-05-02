import express from 'express';
import redis from '../redis/client.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { apiUrl, auth } = req.body;
  if (!apiUrl || !auth) return res.status(400).json({ error: 'Missing data' });
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  await redis.set(sessionId, JSON.stringify({ apiUrl, auth }), 'EX', 3600);
  res.json({ sessionId });
});

export default router; 