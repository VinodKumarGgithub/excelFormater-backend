import express from 'express';

// Import from new module structure
import { logger } from '../lib/services/loggerService.js';
import { authenticateJWT } from './sessions.js';
import { getSuccessfulResponses, getUserActionErrors } from '../lib/services/recordStore.js';
import ApiLog from '../lib/models/ApiLog.js';
import { Op } from 'sequelize';

const router = express.Router();

router.use(authenticateJWT);

// GET /api/logs/:sessionId
// Retrieves all API logs (success + failure) for a given session from MySQL
router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { start = 0, count = 50, type } = req.query;
    
    logger.debug({ sessionId, start, count, type }, 'Fetching logs from DB');
    
    // Build where clause
    const where = { sessionId };
    
    // Filter by type (status): 'success' = 1, 'error' = 0
    if (type) {
      const typeArr = type.split(',').map(t => t.trim().toLowerCase());
      if (typeArr.includes('success') && !typeArr.includes('error')) {
        where.status = 1;
      } else if (typeArr.includes('error') && !typeArr.includes('success')) {
        where.status = 0;
      }
    }
    
    const { count: totalLogs, rows: logs } = await ApiLog.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: Number(start),
      limit: Number(count)
    });
    
    // Format logs into a unified structure
    const formattedLogs = logs.map(log => {
      const isSuccess = log.status === 1;
      return {
        id: log.id,
        time: log.createdAt,
        type: isSuccess ? 'SUCCESS' : 'ERROR',
        transactionId: log.transactionId,
        statusCode: log.statusCode,
        endpoint: log.endpoint,
        responseTime: log.responseTime,
        attemptNumber: log.attemptNumber,
        message: isSuccess
          ? `API call succeeded (${log.statusCode})`
          : (log.errorDetails ? JSON.parse(log.errorDetails)?.message : 'Unknown error'),
        meta: {
          requestPayload: log.requestPayload ? JSON.parse(log.requestPayload) : null,
          responseBody: isSuccess && log.responseBody ? JSON.parse(log.responseBody) : null,
          errorDetails: !isSuccess && log.errorDetails ? JSON.parse(log.errorDetails) : null
        }
      };
    });
    
    logger.debug({ sessionId, totalLogs, fetchedLogs: formattedLogs.length }, 'Logs retrieved from DB');
    
    res.json({
      sessionId,
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
    
    logger.debug({ sessionId, limit }, 'Fetching successful API responses from DB');
    
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

// GET /api/logs/:sessionId/errors
// Retrieve error API logs for a session
router.get('/logs/:sessionId/errors', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit = 100 } = req.query;
    
    logger.debug({ sessionId, limit }, 'Fetching error logs from DB');
    
    const errors = await getUserActionErrors(sessionId);
    
    const limitedErrors = errors.slice(0, parseInt(limit));
    
    res.json({
      sessionId,
      total: errors.length,
      count: limitedErrors.length,
      errors: limitedErrors
    });
  } catch (err) {
    logger.error({ error: err.message, sessionId: req.params.sessionId }, 'Failed to fetch error logs');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:sessionId/summary
// Quick aggregate stats for a session's API logs
router.get('/logs/:sessionId/summary', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const successCount = await ApiLog.count({ where: { sessionId, status: 1 } });
    const errorCount = await ApiLog.count({ where: { sessionId, status: 0 } });
    
    // Average response time for successful calls
    const avgResult = await ApiLog.findOne({
      where: { sessionId, status: 1 },
      attributes: [
        [ApiLog.sequelize.fn('AVG', ApiLog.sequelize.col('responseTime')), 'avgResponseTime'],
        [ApiLog.sequelize.fn('MAX', ApiLog.sequelize.col('responseTime')), 'maxResponseTime'],
        [ApiLog.sequelize.fn('MIN', ApiLog.sequelize.col('responseTime')), 'minResponseTime']
      ],
      raw: true
    });
    
    res.json({
      sessionId,
      successCount,
      errorCount,
      totalLogs: successCount + errorCount,
      avgResponseTime: avgResult?.avgResponseTime ? Math.round(avgResult.avgResponseTime) : 0,
      maxResponseTime: avgResult?.maxResponseTime || 0,
      minResponseTime: avgResult?.minResponseTime || 0
    });
  } catch (err) {
    logger.error({ error: err.message, sessionId: req.params.sessionId }, 'Failed to fetch log summary');
    res.status(500).json({ error: err.message });
  }
});

export default router; 