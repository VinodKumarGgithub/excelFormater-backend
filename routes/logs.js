import express from 'express';
import redis from '../redis.js';
import { authenticateJWT } from './sessions.js';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/logs/:sessionId
router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { start = 0, count = 50, type } = req.query;
    const logs = await redis.lrange(`logs:${sessionId}`, start, start + count - 1);
    let formattedLogs = logs.map(log => {
      try {
        const parsed = JSON.parse(log);
        // Move all additional fields to meta
        const { time, jobId, type, message, ...rest } = parsed;
        return {
          time,
          jobId,
          type,
          message,
          meta: rest
        };
      } catch (e) {
        return { error: 'Invalid log entry', raw: log };
      }
    });
    // Filter by type if provided
    if (type) {
      const typeArr = type.split(',').map(t => t.trim());
      formattedLogs = formattedLogs.filter(log => log.type && typeArr.includes(log.type));
    }
    // Collect unique jobIds from logs
    const jobIds = Array.from(new Set(formattedLogs.map(log => log.jobId).filter(Boolean)));
    res.json({
      sessionId,
      jobId: jobIds.length === 1 ? jobIds[0] : jobIds, // single or array
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