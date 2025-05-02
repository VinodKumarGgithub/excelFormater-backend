import express from 'express';
import { Queue } from 'bullmq';
import redis from '../redis.js';

const batchQueue = new Queue('batchQueue', { connection: redis });
const router = express.Router();

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
    for (const status of statuses) {
      const statusJobs = await batchQueue.getJobs([status], start, end);
      const count = await batchQueue.getJobCountByTypes(status);
      jobs = jobs.concat(statusJobs.map(job => ({
        id: job.id,
        name: job.name,
        status,
        progress: job.progress,
        timestamp: job.timestamp,
        finishedOn: job.finishedOn,
        processedOn: job.processedOn
      })));
      total += count;
    }

    jobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    jobs = jobs.slice(0, pageSize);

    res.json({
      jobs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/pause
router.post('/job/:jobId/pause', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await job.moveToDelayed(Date.now() + 3600 * 1000);
    res.json({ status: 'paused', jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/resume
router.post('/job/:jobId/resume', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.delay && job.delay > 0) {
      await job.promote();
    }
    res.json({ status: 'resumed', jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/:jobId/remove
router.post('/job/:jobId/remove', async (req, res) => {
  try {
    const job = await batchQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await job.remove();
    res.json({ status: 'removed', jobId: req.params.jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/pause
router.post('/queue/pause', async (req, res) => {
  try {
    await batchQueue.pause();
    res.json({ status: 'queue paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/resume
router.post('/queue/resume', async (req, res) => {
  try {
    await batchQueue.resume();
    res.json({ status: 'queue resumed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router; 