import express from 'express';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
import { authenticateJWT } from './sessions.js';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/metrics/:jobId
router.get('/metrics/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const metrics = await redis.hgetall(`metrics:${jobId}`);
    
    if (!metrics || Object.keys(metrics).length === 0) {
      logger.warn({ jobId }, 'No metrics found for job');
      return res.json({ error: 'No metrics found for this job' });
    }
    
    logger.debug({ jobId }, 'Retrieved job metrics');
    res.json(metrics);
  } catch (err) {
    logger.error({ error: err.message, jobId: req.params.jobId }, 'Failed to retrieve job metrics');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/worker-metrics
router.get('/worker-metrics', async (req, res) => {
  try {
    // Get all worker metrics keys
    const keys = await redis.keys('worker:globalMetrics:*');
    const allMetrics = await Promise.all(keys.map(key => redis.get(key)));
    const parsedMetrics = allMetrics
      .map(m => { 
        try { 
          return JSON.parse(m); 
        } catch (e) { 
          logger.warn({ error: e.message }, 'Failed to parse worker metrics');
          return null; 
        } 
      })
      .filter(Boolean);
      
    if (parsedMetrics.length === 0) {
      logger.warn('No worker metrics available');
      return res.status(404).json({ error: 'No metrics available' });
    }

    // Aggregate global summary
    const summary = {
      totalWorkers: parsedMetrics.length,
      totalConcurrency: parsedMetrics.reduce((sum, m) => sum + (m.currentConcurrency || 0), 0),
      avgTimePerRecordMs: Math.round(parsedMetrics.reduce((sum, m) => sum + (m.avgTimePerRecordMs || 0), 0) / parsedMetrics.length),
      estTimeLeftSec: Math.round(parsedMetrics.reduce((sum, m) => sum + (m.estTimeLeftSec || 0), 0) / parsedMetrics.length),
      totalSuccess: parsedMetrics.reduce((sum, m) => sum + (m.successCount || 0), 0),
      totalFailure: parsedMetrics.reduce((sum, m) => sum + (m.failureCount || 0), 0),
      totalBacklog: parsedMetrics.reduce((sum, m) => sum + (m.backlog || 0), 0),
      avgCpu: Number((parsedMetrics.reduce((sum, m) => sum + (m.avgCpu || 0), 0) / parsedMetrics.length).toFixed(2)),
      avgMem: Number((parsedMetrics.reduce((sum, m) => sum + (m.avgMem || 0), 0) / parsedMetrics.length).toFixed(2)),
      avgError: Number((parsedMetrics.reduce((sum, m) => sum + (m.avgError || 0), 0) / parsedMetrics.length).toFixed(3)),
      timestamp: Date.now()
    };

    logger.debug({ workerCount: parsedMetrics.length }, 'Retrieved worker metrics');
    res.json({
      summary,
      workers: parsedMetrics
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to retrieve worker metrics');
    res.status(500).json({ error: err.message });
  }
});

export default router; 