import express from 'express';
import redis from '../redis.js';
import { authenticateJWT } from './sessions.js';
import { apiContextFunctions } from '../worker.js';

const router = express.Router();

// Protect all routes with JWT authentication
router.use(authenticateJWT);

// GET /api/requests/sessions - Get all sessions with API requests
router.get('/requests/sessions', async (req, res) => {
  try {
    // Find all session keys in Redis
    const sessionKeys = await redis.keys('apistats:session:*');
    
    // Process each session to get stats
    const sessions = await Promise.all(
      sessionKeys.map(async (key) => {
        const sessionId = key.replace('apistats:', '');
        const stats = await redis.hgetall(key);
        const total = parseInt(stats.total || 0);
        const success = parseInt(stats.success || 0);
        const failure = parseInt(stats.failure || 0);
        
        // Get session details if available
        let sessionDetails = {};
        try {
          const sessionData = await redis.get(sessionId);
          if (sessionData) {
            sessionDetails = JSON.parse(sessionData);
          }
        } catch (e) {
          console.error(`Error parsing session data for ${sessionId}:`, e.message);
        }
        
        return {
          sessionId,
          total,
          success,
          failure,
          apiUrl: sessionDetails.apiUrl,
          createdAt: sessionId.includes(':') ? 
            new Date(parseInt(sessionId.split(':')[1]) * 1000).toISOString() : 
            undefined
        };
      })
    );
    
    // Sort by total requests (descending)
    sessions.sort((a, b) => b.total - a.total);
    
    res.json({
      count: sessions.length,
      sessions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requests/:sessionId/stats - Get aggregated statistics for a session
router.get('/requests/:sessionId/stats', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Check if session exists
    const sessionExists = await redis.exists(sessionId);
    if (!sessionExists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const stats = await apiContextFunctions.getSessionStats(sessionId);
    
    // Get session details if available
    let sessionDetails = {};
    try {
      const sessionData = await redis.get(sessionId);
      if (sessionData) {
        sessionDetails = JSON.parse(sessionData);
      }
    } catch (e) {
      console.error(`Error parsing session data:`, e.message);
    }
    
    res.json({
      sessionId,
      apiUrl: sessionDetails.apiUrl,
      ...stats,
      errorRate: stats.total > 0 ? (stats.failure / stats.total * 100).toFixed(2) + '%' : '0%'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requests/:sessionId/table - Get API requests for UI table with pagination
router.get('/requests/:sessionId/table', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const page = parseInt(req.query.page) || 0;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const filterSuccess = req.query.success;
    const filterStatus = req.query.status;
    
    // Check if session exists
    const sessionExists = await redis.exists(sessionId);
    if (!sessionExists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Get data with pagination
    const result = await apiContextFunctions.getApiRequestsForTable(sessionId, page, pageSize);
    
    // Apply filters if specified
    if (filterSuccess !== undefined || filterStatus !== undefined) {
      result.data = result.data.filter(item => {
        if (filterSuccess !== undefined) {
          const wantSuccess = filterSuccess === 'true';
          if (item.success !== wantSuccess) return false;
        }
        
        if (filterStatus !== undefined) {
          if (item.responseStatus !== parseInt(filterStatus)) return false;
        }
        
        return true;
      });
    }
    
    res.json({
      sessionId,
      ...result,
      filters: {
        success: filterSuccess,
        status: filterStatus
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requests/:sessionId/:requestId - Get details for a specific request
router.get('/requests/:sessionId/:requestId', async (req, res) => {
  try {
    const { sessionId, requestId } = req.params;
    
    const data = await redis.hgetall(`apidata:${sessionId}:${requestId}`);
    if (!data) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // Convert JSON strings back to objects
    if (data.requestHeaders) data.requestHeaders = JSON.parse(data.requestHeaders);
    if (data.requestBody) data.requestBody = JSON.parse(data.requestBody);
    if (data.responseHeaders) data.responseHeaders = JSON.parse(data.responseHeaders);
    if (data.responseData) data.responseData = JSON.parse(data.responseData);
    
    // Convert numeric strings to numbers
    data.responseStatus = parseInt(data.responseStatus || 0);
    data.success = data.success === '1';
    data.timeMs = parseInt(data.timeMs || 0);
    
    // Add HTTP status text for convenience
    const statusTexts = {
      200: 'OK',
      201: 'Created',
      204: 'No Content',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout'
    };
    
    data.statusText = statusTexts[data.responseStatus] || 'Unknown';
    
    res.json({
      id: requestId,
      ...data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router; 