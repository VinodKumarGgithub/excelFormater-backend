import express from 'express';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
import { authenticateJWT } from './sessions.js';
import workerPool from '../lib/services/workerPool.js';

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

/**
 * Get worker metrics
 */
router.get('/metrics/workers', async (req, res) => {
  try {
    // Get all worker metric keys
    const workerKeys = await redis.keys('worker:globalMetrics:*');
    
    // Get metrics for all workers
    const workerMetrics = await Promise.all(
      workerKeys.map(async (key) => {
        const data = await redis.get(key);
        if (!data) return null;
        
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      })
    );
    
    // Filter out nulls and return
    const metrics = workerMetrics.filter(Boolean);
    res.json({ metrics });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get worker metrics');
    res.status(500).json({ error: 'Failed to get worker metrics' });
  }
});

/**
 * Get API performance metrics
 */
router.get('/metrics/api', async (req, res) => {
  try {
    const apiMetrics = await redis.hgetall('metrics:apiPerformance') || {};
    
    // Parse JSON strings if needed
    if (apiMetrics.statusCodes) {
      try {
        apiMetrics.statusCodes = JSON.parse(apiMetrics.statusCodes);
      } catch (e) {
        apiMetrics.statusCodes = {};
      }
    }
    
    res.json(apiMetrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get API metrics');
    res.status(500).json({ error: 'Failed to get API metrics' });
  }
});

/**
 * Get endpoint performance metrics
 */
router.get('/metrics/endpoints', async (req, res) => {
  try {
    const endpointMetrics = await redis.hgetall('metrics:endpoints') || {};
    
    // Parse JSON strings
    const parsedMetrics = {};
    for (const [key, value] of Object.entries(endpointMetrics)) {
      try {
        parsedMetrics[key] = JSON.parse(value);
      } catch (e) {
        parsedMetrics[key] = { error: 'Failed to parse metrics' };
      }
    }
    
    res.json(parsedMetrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get endpoint metrics');
    res.status(500).json({ error: 'Failed to get endpoint metrics' });
  }
});

/**
 * Get job metrics
 */
router.get('/metrics/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobMetrics = await redis.hgetall(`metrics:${jobId}`);
    
    if (!jobMetrics || Object.keys(jobMetrics).length === 0) {
      return res.status(404).json({ error: 'Job metrics not found' });
    }
    
    res.json(jobMetrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get job metrics');
    res.status(500).json({ error: 'Failed to get job metrics' });
  }
});

/**
 * Get worker pool status and performance metrics
 */
router.get('/metrics/worker-pool', async (req, res) => {
  try {
    // Get general worker pool metrics
    const workerPoolMetrics = {
      initialized: workerPool.initialized,
      workers: workerPool.size,
      queueSize: workerPool.queue?.length || 0,
      availableWorkers: workerPool.workersAvailable?.length || 0,
      activeJobs: workerPool.jobs?.size || 0,
      timestamp: Date.now()
    };
    
    res.json(workerPoolMetrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get worker pool metrics');
    res.status(500).json({ error: 'Failed to get worker pool metrics' });
  }
});

/**
 * Run a performance test to compare worker pool API calls with regular API calls
 */
router.post('/metrics/performance-test', async (req, res) => {
  try {
    const { url, method = 'GET', data = {}, iterations = 10 } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Test 1: Using worker pool
    const workerPoolStart = Date.now();
    const workerPoolPromises = [];
    
    for (let i = 0; i < iterations; i++) {
      workerPoolPromises.push(
        workerPool.makeApiCall({
          url,
          method,
          data
        })
      );
    }
    
    await Promise.all(workerPoolPromises);
    const workerPoolDuration = Date.now() - workerPoolStart;
    
    // Test 2: Using direct API calls
    const directApiStart = Date.now();
    const directApiPromises = [];
    
    for (let i = 0; i < iterations; i++) {
      directApiPromises.push(
        (async () => {
          const { api } = await import('../lib/services/apiClient.js');
          return api.request({
            url,
            method,
            data
          });
        })()
      );
    }
    
    await Promise.all(directApiPromises);
    const directApiDuration = Date.now() - directApiStart;
    
    // Results
    const results = {
      iterations,
      workerPool: {
        totalDurationMs: workerPoolDuration,
        avgRequestMs: workerPoolDuration / iterations
      },
      directApi: {
        totalDurationMs: directApiDuration,
        avgRequestMs: directApiDuration / iterations
      },
      improvement: {
        totalMs: directApiDuration - workerPoolDuration,
        percentage: ((directApiDuration - workerPoolDuration) / directApiDuration * 100).toFixed(2) + '%'
      }
    };
    
    // Store test results in Redis
    await redis.hset('metrics:performanceTests', {
      [`test:${Date.now()}`]: JSON.stringify({
        ...results,
        url,
        method,
        timestamp: new Date().toISOString()
      })
    });
    
    res.json(results);
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Performance test failed');
    res.status(500).json({ error: 'Performance test failed', details: error.message });
  }
});

export default router; 