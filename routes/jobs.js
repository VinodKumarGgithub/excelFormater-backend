import express from 'express';
import { Queue } from 'bullmq';
import redis from '../lib/redis.js';
import { authenticateJWT } from './sessions.js';
import { DownloadJob } from '../models/index.js';

const batchQueue = new Queue('batchQueue', { connection: redis });
const downloadQueue = new Queue('downloadQueue', { connection: redis})
const router = express.Router();

router.use(authenticateJWT);

// POST /api/queue-batch
router.post('/queue-batch', async (req, res) => {
  const { sessionId, records } = req.body;
  if (!sessionId || !records) return res.status(400).json({ success: false, message: 'Missing data' });
  await batchQueue.add(`processBatch-${sessionId}`, { sessionId, records },{
    removeOnComplete: true,
    removeOnFail: false,
  });
  res.json({ success: true, message: 'Batch queued successfully' });
});

// post download job
router.post('/post-job', async (req, res) => {
  const { sessionId, prefix, dbURI } = req.body;
  if (!sessionId || !prefix || !dbURI) return res.status(400).json({ success: false, message: 'Missing data' });
  
  try {
    // Create download job record in database
    const downloadJob = await DownloadJob.create({
      sessionId,
      prefix,
      targetdbURI: dbURI,
      status: 'PENDING'
    });
    
    // Add job to queue
    await downloadQueue.add(`downloadQueue`, { 
      sessionId, 
      prefix, 
      dbURI,
      downloadJobId: downloadJob.id 
    });
    
    res.json({ 
      success: true, 
      message: 'Download job queued successfully',
      downloadJobId: downloadJob.id
    });
  } catch (error) {
    console.error('Error creating download job:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create download job',
      error: error.message 
    });
  }
});

// Get download job status
router.get('/download-job/:downloadJobId', async (req, res) => {
  const { downloadJobId } = req.params;
  
  try {
    const downloadJob = await DownloadJob.findByPk(downloadJobId);
    if (!downloadJob) {
      return res.status(404).json({ success: false, message: 'Download job not found' });
    }
    
    res.json({ success: true, downloadJob });
  } catch (error) {
    console.error('Error fetching download job:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch download job',
      error: error.message 
    });
  }
});

// Get all download jobs for a session
router.get('/download-jobs/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const downloadJobs = await DownloadJob.findAll({
      where: { sessionId },
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, downloadJobs });
  } catch (error) {
    console.error('Error fetching download jobs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch download jobs',
      error: error.message 
    });
  }
});

export default router; 