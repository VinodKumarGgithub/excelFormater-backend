import express from 'express';
import redis from '../redis.js';
import { authenticateJWT } from './sessions.js';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/metrics/:jobId
router.get('/metrics/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const metrics = await redis.hgetall(`metrics:${jobId}`);
    res.json(metrics || { error: 'No metrics found for this job' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/worker-metrics
router.get('/worker-metrics', async (req, res) => {
  try {
    const metrics = await redis.get('worker:globalMetrics');
    if (!metrics) return res.status(404).json({ error: 'No metrics available' });
    res.json(JSON.parse(metrics));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router; 