import express from 'express';
import jwt from 'jsonwebtoken';

// Import from new module structure
import redis from '../lib/config/redisConfig.js';
import { logger } from '../lib/services/loggerService.js';
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
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH.DEMO_USER.username && password === AUTH.DEMO_USER.password) {
    const token = jwt.sign({ username }, ENV.JWT_SECRET, { expiresIn: AUTH.TOKEN_EXPIRY });
    logger.info({ username }, 'User logged in successfully');
    return res.json({
      token,
      user: { username },
      message: 'Login successful'
    });
  }
  
  logger.warn({ username, ip: req.ip }, 'Login attempt with invalid credentials');
  res.status(401).json({ error: 'Invalid credentials' });
});

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  const { apiUrl, auth } = req.body;
  
  if (!apiUrl || !auth) {
    logger.warn({ ip: req.ip }, 'Session initialization failed - missing data');
    return res.status(400).json({ error: 'Missing data' });
  }
  
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  await redis.set(sessionId, JSON.stringify({ apiUrl, auth }), 'EX', QUEUE.SESSION_TTL);
  
  logger.info({ sessionId }, 'New session initialized');
  res.json({ sessionId });
});

// Protect all routes below this line
router.use(authenticateJWT);

// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const keys = await redis.keys('logs:*');
    const sessions = keys.map(key => key.replace('logs:', ''));
    const sessionInfo = await Promise.all(
      sessions.map(async (sessionId) => {
        const logCount = await redis.llen(`logs:${sessionId}`);
        const ttl = await redis.ttl(`logs:${sessionId}`);
        return {
          sessionId,
          logCount,
          ttl
        };
      })
    );
    res.json(sessionInfo);
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to fetch sessions');
    res.status(500).json({ error: err.message });
  }
});

export default router; 