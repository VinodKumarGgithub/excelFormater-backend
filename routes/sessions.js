import express from 'express';
import redis from '../lib/redis.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'sd@!v@#$%^&*()_+';
const DEMO_USER = { username: 'admin', password: 'password123', role: 'admin', userId: '864616516-dfsd-564' };

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
      user: { username, role: DEMO_USER.role, userId: DEMO_USER.userId },
      message: 'Login successful'
    });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// Protect all routes below this line
router.use(authenticateJWT);

// POST /api/init-session
router.post('/init-session', async (req, res) => {
  const { apiUrl, auth } = req.body;
  if (!apiUrl || !auth) return res.status(400).json({ error: 'Missing data' });
  const sessionId = 'session:' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

  await redis.set(sessionId, JSON.stringify({ apiUrl, auth })); // no expiration
  // Push sessionId to user session list
  await redis.lpush(`user:sessions:${req.user.username}`, sessionId);
  res.json({ sessionId });
});

// GET /api/sessions
router.get('/sessions', async (req, res) => {
  try {
    const { userId, role } = req.user || {}; // Adjust according to your auth middleware

    let sessionIds = [];

    if (role === 'admin') {
      // Admin: get all session keys
      const keys = await redis.keys('session:*');
      sessionIds = keys.map(key => key.replace('session:', ''));
    } else {
      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
      }
      // Non-admin: get sessions from user's list
      sessionIds = await redis.lrange(`user:sessions:${userId}`, 0, -1);
    }

    const sessionInfo = await Promise.all(
      sessionIds.map(async (sessionId) => {
        // Get session details
        const sessionData = await redis.get(`session:${sessionId}`);
        const sessionDetails = sessionData ? JSON.parse(sessionData) : {};

        // Extract timestamp from sessionId (assuming same format)
        const timestampPart = sessionId.slice(8, 16); // adjust if needed
        const createdAt = timestampPart
          ? new Date(parseInt(timestampPart, 36) * 1000).toISOString()
          : null;

        return {
          sessionId,
          apiUrl: sessionDetails.apiUrl,
          createdAt,
        };
      })
    );

    res.json(sessionInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


export default router; 