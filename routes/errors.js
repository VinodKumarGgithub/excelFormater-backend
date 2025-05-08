/**
 * API routes for handling errors, especially user action errors
 */
import express from 'express';
import { authenticateJWT } from './sessions.js';
import { getUserActionErrors, resolveUserActionError } from '../lib/services/processRecord.js';
import { logger } from '../lib/services/loggerService.js';
import workerPool from '../lib/services/workerPool.js';

const router = express.Router();

// Require authentication for all routes
router.use(authenticateJWT);

/**
 * Get all user action errors for a session
 * GET /api/errors/user-action/:sessionId
 */
router.get('/errors/user-action/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get user action errors from Redis
    const errors = await getUserActionErrors(sessionId);
    
    logger.info({
      sessionId,
      count: errors.length
    }, 'Retrieved user action errors');
    
    res.json({
      errors,
      count: errors.length
    });
  } catch (error) {
    logger.error({
      error: error.message,
      sessionId: req.params.sessionId
    }, 'Failed to get user action errors');
    
    res.status(500).json({
      error: 'Failed to get user action errors',
      message: error.message
    });
  }
});

/**
 * Get summary of all error categories
 * GET /api/errors/summary
 */
router.get('/errors/summary', async (req, res) => {
  try {
    // Get error stats from worker pool
    const stats = workerPool.getErrorStats();
    
    res.json({
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({
      error: error.message
    }, 'Failed to get error summary');
    
    res.status(500).json({
      error: 'Failed to get error summary',
      message: error.message
    });
  }
});

/**
 * Resolve a user action error
 * POST /api/errors/user-action/:errorId/resolve
 */
router.post('/errors/user-action/:errorId/resolve', async (req, res) => {
  try {
    const { errorId } = req.params;
    const resolution = req.body;
    
    // Validate resolution data
    if (!resolution || typeof resolution !== 'object') {
      return res.status(400).json({
        error: 'Resolution data is required'
      });
    }
    
    // Resolve the error
    const result = await resolveUserActionError(errorId, resolution);
    
    if (!result) {
      return res.status(404).json({
        error: 'Error not found or already resolved'
      });
    }
    
    logger.info({
      errorId,
      resolution
    }, 'User action error resolved');
    
    res.json({
      success: true,
      errorId,
      message: 'Error resolved successfully'
    });
  } catch (error) {
    logger.error({
      error: error.message,
      errorId: req.params.errorId
    }, 'Failed to resolve user action error');
    
    res.status(500).json({
      error: 'Failed to resolve user action error',
      message: error.message
    });
  }
});

/**
 * Reprocess a record after resolving a user action error
 * POST /api/errors/user-action/:errorId/reprocess
 */
router.post('/errors/user-action/:errorId/reprocess', async (req, res) => {
  try {
    const { errorId } = req.params;
    const { record, apiUrl, headers } = req.body;
    
    // Validate required fields
    if (!record || !apiUrl) {
      return res.status(400).json({
        error: 'Record and API URL are required'
      });
    }
    
    // Make sure the error exists
    const errorData = await getUserActionErrors(errorId.split(':')[0]);
    const error = errorData.find(e => e.errorId === errorId);
    
    if (!error) {
      return res.status(404).json({
        error: 'Error not found'
      });
    }
    
    // Make the API call with the updated record
    const result = await workerPool.makeApiCall({
      url: apiUrl,
      method: 'POST',
      data: record,
      headers: headers || {}
    });
    
    // Mark the error as resolved if API call was successful
    if (result && result.status < 400) {
      await resolveUserActionError(errorId, {
        reprocessed: true,
        success: true,
        result: {
          status: result.status,
          data: result.data
        }
      });
    }
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    logger.error({
      error: error.message,
      errorId: req.params.errorId
    }, 'Failed to reprocess record');
    
    res.status(500).json({
      error: 'Failed to reprocess record',
      message: error.message
    });
  }
});

/**
 * Clear all user action errors for a session
 * DELETE /api/errors/user-action/:sessionId
 */
router.delete('/errors/user-action/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get error IDs
    const errors = await getUserActionErrors(sessionId);
    
    // Resolve all errors
    for (const error of errors) {
      await resolveUserActionError(error.errorId, {
        status: 'cleared',
        message: 'Cleared by user'
      });
    }
    
    logger.info({
      sessionId,
      count: errors.length
    }, 'Cleared all user action errors');
    
    res.json({
      success: true,
      count: errors.length,
      message: `Cleared ${errors.length} user action errors`
    });
  } catch (error) {
    logger.error({
      error: error.message,
      sessionId: req.params.sessionId
    }, 'Failed to clear user action errors');
    
    res.status(500).json({
      error: 'Failed to clear user action errors',
      message: error.message
    });
  }
});

export default router; 