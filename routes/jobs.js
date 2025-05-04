import express from 'express';
import { Queue } from 'bullmq';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
import { authenticateJWT } from './sessions.js';

const batchQueue = new Queue('batchQueue', { connection: redis });
const router = express.Router();

router.use(authenticateJWT);

// GET /api/jobs?status=waiting,active,completed,failed,delayed&page=1&pageSize=10
router.get('/jobs', async (req, res) => {
  try {
    const statusParam = req.query.status || 'waiting,active,completed,failed,delayed';
    const statuses = statusParam.split(',');
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;

    let jobs = [];
    let total = 0;
    const statusTotals = {};
    
    for (const status of statuses) {
      const statusJobs = await batchQueue.getJobs([status], start, end);
      const count = await batchQueue.getJobCountByTypes(status);
      statusTotals[status] = count;
      
      jobs = jobs.concat(statusJobs.map(job => ({
        id: job.id,
        name: job.name,
        status,
        meta: {
          TransactionId: job.data?.records[0]?.requestId,
          MemberId: job.data?.records[0]?.memberId,
          PayerId: job.data?.records[0]?.payerId,
        },
        progress: job.progress,
        timestamp: job.timestamp,
        finishedOn: job.finishedOn,
        processedOn: job.processedOn
      })));
      
      total += count;
    }

    jobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    jobs = jobs.slice(0, pageSize);

    logger.debug({ jobCount: jobs.length, total }, 'Retrieved jobs list');

    res.json({
      jobs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      },
      statusTotals
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to retrieve jobs');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/pause
router.post('/job/:jobId/pause', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) {
      logger.warn({ jobId: req.params.jobId }, 'Job not found for pause operation');
      return res.status(404).json({ error: 'Job not found' });
    }
    
    await job.moveToDelayed(Date.now() + 3600 * 1000);
    logger.info({ jobId: job.id }, 'Job paused');
    res.json({ status: 'paused', jobId: job.id });
  } catch (err) {
    logger.error({ error: err.message, jobId: req.params.jobId }, 'Failed to pause job');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/resume
router.post('/job/:jobId/resume', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) {
      logger.warn({ jobId: req.params.jobId }, 'Job not found for resume operation');
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.delay && job.delay > 0) {
      await job.promote();
    }
    
    logger.info({ jobId: job.id }, 'Job resumed');
    res.json({ status: 'resumed', jobId: job.id });
  } catch (err) {
    logger.error({ error: err.message, jobId: req.params.jobId }, 'Failed to resume job');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/remove
router.post('/job/:jobId/remove', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) {
      logger.warn({ jobId: req.params.jobId }, 'Job not found for remove operation');
      return res.status(404).json({ error: 'Job not found' });
    }
    
    await job.remove();
    logger.info({ jobId: req.params.jobId }, 'Job removed');
    res.json({ status: 'removed', jobId: req.params.jobId });
  } catch (err) {
    logger.error({ error: err.message, jobId: req.params.jobId }, 'Failed to remove job');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/pause
router.post('/queue/pause', async (req, res) => {
  try {
    await batchQueue.pause();
    logger.info('Queue paused');
    res.json({ status: 'queue paused' });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to pause queue');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/resume
router.post('/queue/resume', async (req, res) => {
  try {
    await batchQueue.resume();
    logger.info('Queue resumed');
    res.json({ status: 'queue resumed' });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to resume queue');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue-batch
router.post('/queue-batch', async (req, res) => {
  const { sessionId, records } = req.body;
  
  if (!sessionId || !records) {
    logger.warn('Missing data for queue-batch operation');
    return res.status(400).json({ error: 'Missing data' });
  }
  
  try {
    const job = await batchQueue.add('processBatch', { sessionId, records });
    logger.info({ sessionId, jobId: job.id, recordCount: records.length }, 'Batch job queued');
    res.json({ status: 'queued', jobId: job.id });
  } catch (err) {
    logger.error({ error: err.message, sessionId }, 'Failed to queue batch');
    res.status(500).json({ error: err.message });
  }
});

export default router; 