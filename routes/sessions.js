import express from 'express';
import jwt from 'jsonwebtoken';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
import bcrypt from 'bcryptjs';
import User from '../lib/models/User.js';
import Session from '../lib/models/Session.js';
import { ENV, AUTH, QUEUE } from '../lib/config/appConfig.js';

const router = express.Router();

// JWT authentication middleware
export function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, ENV.JWT_SECRET, (err, user) => {
      if (err) {
        logger.warn({ error: err.message, ip: req.ip }, 'JWT authentication failed');
        return res.status(401).json({ error: 'Invalid token' });
      }
      req.user = user;
      next();
    });
  } else {
    res.status(401).json({ error: 'No token provided' });
  }
}

// POST /api/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Find user in database
    const user = await User.findOne({ where: { username } });
    if (!user) {
      logger.warn({ username, ip: req.ip }, 'Login attempt with invalid username');
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (user.status !== 'ACTIVE') {
      logger.warn({ username, ip: req.ip }, 'Login attempt for inactive user');
      return res.status(403).json({ success: false, error: 'Account is inactive or suspended' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      logger.warn({ username, ip: req.ip }, 'Login attempt with invalid password');
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Generate JWT attaching user ID
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      ENV.JWT_SECRET,
      { expiresIn: AUTH.TOKEN_EXPIRY }
    );

    logger.info({ username: user.username }, 'User logged in successfully from DB');
    return res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
      message: 'Login successful'
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Login failed due to server error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/register
router.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      password: hashedPassword,
      role: role || 'USER',
      status: 'ACTIVE'
    });

    logger.info({ username }, 'New user registered successfully');
    
    // Generate JWT
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, role: newUser.role },
      ENV.JWT_SECRET,
      { expiresIn: AUTH.TOKEN_EXPIRY }
    );

    res.status(201).json({
      success: true,
      token,
      user: { id: newUser.id, username: newUser.username, role: newUser.role },
      message: 'User registered successfully'
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Registration failed');
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protect all routes below this line
router.use(authenticateJWT);

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  const { apiUrl, auth, method, totalTxn, fileSize, fileType } = req.body;
  
  if (!apiUrl || !auth) {
    logger.warn({ ip: req.ip }, 'Session initialization failed - missing data');
    return res.status(400).json({ success: false, error: 'Missing data', message: 'apiUrl and auth are required' });
  }
  
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  const sessionConfig = { apiUrl, auth, method: method || 'POST' };
  
  // Persist session to MySQL
  try {
    let authUsername = null;
    let authPassword = null;
    
    if (auth && auth.type === 'basic') {
      authUsername = auth.username;
      authPassword = auth.password;
    }

    await Session.create({
      sessionId,
      sourceFileType: fileType || null,
      fileSize: fileSize || 0,
      txnCount: totalTxn || 0,
      sessionConfig,
      apiUrl: apiUrl,
      apiMethod: method || 'POST',
      apiType: 'REST', // Defaults to REST for Excel uploads
      authUsername,
      authPassword,
      status: 'PENDING',
      startedAt: new Date(),
      createdBy: req.user.id
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to persist session to DB');
    return res.status(500).json({ success: false, error: 'Could not write session config to backend DB' });
  }

  // Backup persist cache to Redis for legacy backward-compatible active worker runtime processing
  const legacySessionData = {
    ...sessionConfig,
    totalTxn: totalTxn || 0,
    fileSize: fileSize || 0,
    fileType: fileType || null,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  };
  await redis.set(sessionId, JSON.stringify(legacySessionData), 'EX', QUEUE.SESSION_TTL);
  
  logger.info({ sessionId }, 'New session strictly initialized in DB and cached');
  res.json({
    success: true,
    sessionId,
    message: 'Session initialized successfully',
    data: {
      sessionId,
      apiUrl,
      method: sessionConfig.method,
      fileSize: fileSize || 0,
      fileType: fileType || null,
      status: 'ACTIVE',
      createdAt: legacySessionData.createdAt,
    }
  });
});


// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    
    // Read directly from DB instead of Redis
    const { count, rows: sessionsData } = await Session.findAndCountAll({
      limit: Number(limit),
      offset: Number(offset),
      order: [['createdAt', 'DESC']],
      include: [
        { model: User, attributes: ['id', 'username', 'role', 'status'] }
      ]
    });
    
    // Map output combining DB properties + live log counts from ApiLog table
    const ApiLog = (await import('../lib/models/ApiLog.js')).default;
    const mappedSessions = await Promise.all(
      sessionsData.map(async (dbSession) => {
        const sessionId = dbSession.sessionId;
        const logCount = await ApiLog.count({ where: { sessionId } });
        
        return {
          sessionId,
          apiUrl: dbSession.apiUrl,
          method: dbSession.apiMethod,
          fileSize: dbSession.fileSize,
          fileType: dbSession.sourceFileType,
          totalTxn: dbSession.txnCount,
          status: dbSession.status,
          successCount: dbSession.successCount,
          errorCount: dbSession.errorCount,
          createdAt: dbSession.createdAt,
          startedAt: dbSession.startedAt,
          completedAt: dbSession.completedAt,
          user: dbSession.User ? { username: dbSession.User.username, id: dbSession.User.id } : null,
          logCount
        };
      })
    );
    
    res.json({
      success: true,
      data: mappedSessions,
      pagination: {
        total: count,
        limit: Number(limit),
        offset: Number(offset),
        pages: Math.ceil(count / Number(limit))
      }
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to fetch sessions from database');
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router; 