import express from 'express';
import redis from '../redis.js';

const router = express.Router();

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

export default router; 