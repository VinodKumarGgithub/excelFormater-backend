import express from 'express';
import redis from '../redis.js';

const router = express.Router();

// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const keys = await redis.keys('logs:*');
    const sessions = keys.map(key => key.replace('logs:', ''));
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

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  const { apiUrl, auth } = req.body;
  if (!apiUrl || !auth) return res.status(400).json({ error: 'Missing data' });
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  await redis.set(sessionId, JSON.stringify({ apiUrl, auth }), 'EX', 86400); // add 1 week
  res.json({ sessionId });
});

export default router; 