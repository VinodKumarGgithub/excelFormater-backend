import express from 'express';
import redis from '../lib/redis.js';
import { authenticateJWT } from './sessions.js';
import { apiContextFunctions } from '../services/api-context.js';
import { redisKeys } from '../lib/redis/redisKeys.js';

const router = express.Router();

// Protect all routes with JWT authentication
router.use(authenticateJWT);

// GET /api/requests/sessions - Get all sessions with API requests using HyperLogLog
router.get('/requests/sessions', async (req, res) => {
  try {
    // Find all session keys in Redis using set pattern
    const sessionKeys = await redis.keys('apistats:session:*:total');
    
    // Process each session to get stats using sets
    const sessions = await Promise.all(
      sessionKeys.map(async (key) => {
        const sessionId = key.replace('apistats:', '').replace(':total', '');
        
        // Get set counts for this session
        const [total, success, failure] = await Promise.all([
          redis.scard(redisKeys.apiTotal(sessionId)),
          redis.scard(redisKeys.apiSuccess(sessionId)),
          redis.scard(redisKeys.apiFailure(sessionId))
        ]);
        
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
          total: total || 0,
          success: success || 0,
          failure: failure || 0,
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
    let { sessionId } = req.params;
    sessionId = sessionId?.replace("session:","");
    
    // Check if session exists
    const sessionExists = await redis.exists(`session:${sessionId}`);
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
    let { sessionId } = req.params;
    sessionId = sessionId?.replace("session:","");
    const page = parseInt(req.query.page) || 0;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const filterSuccess = req.query.success;
    const filterStatus = req.query.status;
    const filterRetriable = req.query.retriable === 'true';
    
    // Check if session exists
    const sessionExists = await redis.exists(`session:${sessionId}`);
    if (!sessionExists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Get data with pagination
    const result = await apiContextFunctions.getApiRequestsForTable(sessionId, page, pageSize);
    
    // Apply filters if specified
    if (filterSuccess !== undefined || filterStatus !== undefined || filterRetriable) {
      result.data = result.data.filter(item => {
        if (filterSuccess !== undefined) {
          const wantSuccess = filterSuccess === 'true';
          if (item.success !== wantSuccess) return false;
        }
        
        if (filterStatus !== undefined) {
          if (item.responseStatus !== parseInt(filterStatus)) return false;
        }
        
        if (filterRetriable) {
          if (!item.canRetry) return false;
        }
        
        return true;
      });
    }
    
    res.json({
      sessionId,
      ...result,
      filters: {
        success: filterSuccess,
        status: filterStatus,
        retriable: filterRetriable
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
    
    // Add flag to indicate if this request can be retried (4xx errors)
    data.canRetry = !data.success && data.responseStatus >= 400 && data.responseStatus < 500;
    
    res.json({
      id: requestId,
      ...data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/requests/:sessionId/:requestId/retry - Retry a specific API request with modifications
router.post('/requests/:sessionId/:requestId/retry', async (req, res) => {
  try {
    let { sessionId, requestId } = req.params;
    const { modifiedRequestBody } = req.body;
    sessionId = `session:${sessionId?.replace("session:","")}`;
    
    // Check if the request exists
    const requestExists = await redis.exists(`apidata:${sessionId}:${requestId}`);
    if (!requestExists) {
      return res.status(404).json({ error: 'Original request not found' });
    }
    
    // Retry the request
    const result = await apiContextFunctions.retryApiRequest(
      sessionId, 
      requestId,
      modifiedRequestBody
    );
    
    res.json({
      success: true,
      message: 'API request retried',
      originalRequestId: requestId,
      newRequestId: result.newRequestId,
      result
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// POST /api/requests/:sessionId/retry-all - Retry all failed requests for a session
router.post('/requests/:sessionId/retry-all', async (req, res) => {
  try {
    let { sessionId } = req.params;
    sessionId = `session:${sessionId?.replace("session:","")}`;
    
    // Check if session exists
    const sessionExists = await redis.exists(`session:${sessionId}`);
    if (!sessionExists) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Retry all failed requests
    const result = await apiContextFunctions.retryAllFailedRequests(sessionId);
    
    res.json({
      success: true,
      message: result.message,
      sessionId,
      results: result.results,
      summary: result.summary
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

router.get('/chart-data/:sessionId', async (req, res) => {
  let { sessionId } = req.params;
  sessionId = sessionId?.replace("session:","");

  try {
    // Pattern to match List keys: api:chart:session:<sessionId>:requests:*:success and :failure
    const successPattern = `api:chart:session:${sessionId}:requests:*:success`;
    const failurePattern = `api:chart:session:${sessionId}:requests:*:failure`;

    // Use SCAN to find all time-based keys
    let cursor = '0';
    let successKeys = [];
    let failureKeys = [];
    
    // Get success keys
    do {
      const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', successPattern, 'COUNT', 100);
      cursor = nextCursor;
      successKeys = successKeys.concat(foundKeys);
    } while (cursor !== '0');

    // Get failure keys
    cursor = '0';
    do {
      const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', failurePattern, 'COUNT', 100);
      cursor = nextCursor;
      failureKeys = failureKeys.concat(foundKeys);
    } while (cursor !== '0');

    // Combine and sort keys chronologically
    const allKeys = [...successKeys, ...failureKeys];
    const uniqueTimeKeys = [...new Set(allKeys.map(key => {
      const parts = key.split(':');
      return parts[parts.length - 2]; // Get the time part (timestamp)
    }))].sort((a, b) => parseInt(a) - parseInt(b)); // Sort by timestamp numerically

    // Get List lengths for each time period (exact counts)
    const chartData = await Promise.all(
      uniqueTimeKeys.map(async (time) => {
        const successCount = await redis.llen(`api:chart:session:${sessionId}:requests:${time}:success`);
        const failureCount = await redis.llen(`api:chart:session:${sessionId}:requests:${time}:failure`);
        
        // Convert timestamp back to readable format for frontend
        const readableTime = new Date(parseInt(time)).toISOString();
        
        return {
          timestamp: readableTime,
          time: parseInt(time),
          success: successCount || 0,
          failure: failureCount || 0,
        };
      })
    );

    res.json({ success: true, message: 'chart data found', sessionId, chartData });

  } catch (err) {
    console.error('Error fetching chart data:', err);
    res.status(500).json({ success:false, error: 'Failed to fetch chart data' });
  }
});

export default router; 