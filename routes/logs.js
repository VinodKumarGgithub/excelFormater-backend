import express from 'express';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
import { authenticateJWT } from './sessions.js';
import { getSuccessfulResponses } from '../lib/services/processRecord.js';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/logs/:sessionId
// Note: For API interactions, logs of type 'API_CALL' will contain both request and response (or error) details in the meta field.
router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { start = 0, count = 50, type } = req.query;
    
    logger.debug({ sessionId, start, count, type }, 'Fetching logs');
    
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
        logger.warn({ error: e.message, rawLog: log }, 'Invalid log entry');
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
    
    const totalLogs = await redis.llen(`logs:${sessionId}`);
    logger.debug({ sessionId, totalLogs, fetchedLogs: formattedLogs.length }, 'Logs retrieved');
    
    res.json({
      sessionId,
      jobId: jobIds.length === 1 ? jobIds[0] : jobIds, // single or array
      total: totalLogs,
      start: parseInt(start),
      count: formattedLogs.length,
      logs: formattedLogs
    });
  } catch (err) {
    logger.error({ error: err.message, sessionId: req.params.sessionId }, 'Failed to fetch logs');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:sessionId/success
// Retrieve successful API responses for a session
router.get('/logs/:sessionId/success', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit = 100 } = req.query;
    
    logger.debug({ sessionId, limit }, 'Fetching successful API responses');
    
    // Get successful responses using our new function
    const responses = await getSuccessfulResponses(sessionId);
    
    // Limit the number of responses if needed
    const limitedResponses = responses.slice(0, parseInt(limit));
    
    res.json({
      sessionId,
      total: responses.length,
      count: limitedResponses.length,
      responses: limitedResponses
    });
  } catch (err) {
    logger.error({ error: err.message, sessionId: req.params.sessionId }, 'Failed to fetch successful API responses');
    res.status(500).json({ error: err.message });
  }
});

export default router; 