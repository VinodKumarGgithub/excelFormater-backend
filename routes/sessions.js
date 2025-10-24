import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticate } from '../services/userService.js';
import { 
  createSession, 
  getSessionById, 
  getSessionsByUserId, 
  getAllSessions,
  updateSessionStatus,
  updateSession,
  deleteSession,
  getSessionStats
} from '../services/sessionService.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'sd@!v@#$%^&*()_+';

// JWT authentication middleware
export function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(401).json({ success: false, message: 'Invalid token' });
      req.user = user;
      next();
    });
  } else {
    res.status(401).json({ success: false, message: 'No token provided' });
  }
}

// POST /api/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try{

  const user = await authenticate(username, password);
  if (user) {
    const token = jwt.sign({ userId: user.userId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: { username, role: user.role },
      success: true,
      message: 'Login successful'
    });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
  }
});

// Protect all routes below this line
router.use(authenticateJWT);

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  try {
    const { apiUrl, auth, method, fileSize, fileType, totalTxn } = req.body;
    
    if (!apiUrl || !auth || !method) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: apiUrl, auth, method' 
      });
    }
    
    // Generate session ID
    const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    
    // Create session in both database and Redis
    const session = await createSession({
      sessionId,
      userId: req.user.userId,
      apiUrl,
      auth,
      method,
      fileSize: fileSize || 0,
      fileType: fileType || null,
      totalTxn: totalTxn || 0,
    });
    
    res.json({ 
      success: true, 
      sessionId,
      message: 'Session initialized successfully',
      data: {
        sessionId,
        apiUrl,
        method,
        fileSize: fileSize || 0,
        fileType: fileType || null,
        status: 'PENDING',
        createdAt: session.createdAt
      }
    });
  } catch (error) {
    console.error('Error initializing session:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to initialize session' 
    });
  }
});

// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const { userId, role } = req.user || {};
    const { limit = 50, offset = 0, status } = req.query;

    let result;

    if (role === 'ADMIN') {
      // Admin: get all sessions
      result = await getAllSessions({
        limit: parseInt(limit),
        offset: parseInt(offset),
        status
      });
    } else {
      if (!userId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Missing userId' 
        });
      }
      // Non-admin: get user's sessions
      result = await getSessionsByUserId(userId, {
        limit: parseInt(limit),
        offset: parseInt(offset),
        status
      });
    }

    res.json({
      success: true,
      data: result.sessions,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to fetch sessions' 
    });
  }
});

// GET /api/sessions/:sessionId
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, role } = req.user || {};

    const session = await getSessionById(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Check if user has access to this session
    if (role !== 'ADMIN' && session.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: session
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch session'
    });
  }
});

// PUT /api/sessions/:sessionId
router.put('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, role } = req.user || {};
    const updateData = req.body;

    // Check if user has access to this session
    const session = await getSessionById(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    if (role !== 'ADMIN' && session.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const updatedSession = await updateSession(sessionId, updateData);

    res.json({
      success: true,
      message: 'Session updated successfully',
      data: updatedSession
    });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update session'
    });
  }
});

// DELETE /api/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, role } = req.user || {};

    // Check if user has access to this session
    const session = await getSessionById(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    if (role !== 'ADMIN' && session.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    await deleteSession(sessionId);

    res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete session'
    });
  }
});

// GET /api/sessions/stats
router.get('/sessions/stats', async (req, res) => {
  try {
    const { userId, role } = req.user || {};

    let stats;
    if (role === 'ADMIN') {
      // Admin: get all session stats
      stats = await getSessionStats();
    } else {
      // User: get their session stats
      stats = await getSessionStats(userId);
    }

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching session stats:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch session statistics'
    });
  }
});


export default router; 