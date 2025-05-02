import express from 'express';
import redis from '../redis.js';
import { authenticateJWT } from './sessions.js';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/logs/:sessionId
router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { start = 0, count = 50 } = req.query;
    const logs = await redis.lrange(`logs:${sessionId}`, start, start + count - 1);
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

export default router; 