import express from 'express';
import redis from '../redis.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'sd@!v@#$%^&*()_+';
const DEMO_USER = { username: 'admin', password: 'password123' };

// JWT authentication middleware
export function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(401).json({ error: 'Invalid token' });
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
  if (username === DEMO_USER.username && password === DEMO_USER.password) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: { username },
      message: 'Login successful'
    });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  const { apiUrl, auth } = req.body;
  if (!apiUrl || !auth) return res.status(400).json({ error: 'Missing data' });
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  await redis.set(sessionId, JSON.stringify({ apiUrl, auth }), 'EX', 86400); // add 1 week
  res.json({ sessionId });
});

// Protect all routes below this line
router.use(authenticateJWT);

// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const keys = await redis.keys('session:*');
    const sessions = keys.map(key => key.replace('session:', ''));
    const sessionInfo = await Promise.all(
      sessions.map(async (sessionId) => {
        // Get session details
        const sessionData = await redis.get(`session:${sessionId}`);
        const sessionDetails = sessionData ? JSON.parse(sessionData) : {};
        
        // Get log count and TTL
        const logCount = await redis.llen(`logs:${sessionId}`);
        const ttl = await redis.ttl(`session:${sessionId}`);
        
        return {
          sessionId,
          apiUrl: sessionDetails.apiUrl,
          logCount,
          ttl,
          createdAt: new Date(parseInt(sessionId.split('').slice(0, 8).join(''), 36) * 1000).toISOString(),
        };
      })
    );
    res.json(sessionInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router; 