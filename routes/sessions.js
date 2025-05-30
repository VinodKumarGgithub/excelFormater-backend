import express from 'express';
import redis from '../lib/redis.js';
import jwt from 'jsonwebtoken';
import { getDemoUser } from '../lib/demousers.js';
import jwksClient from 'jwks-rsa';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'sd@!v@#$%^&*()_+';
const MS_CLIENT_ID = process.env.CLIENT_ID || '13712633-346e-4b99-b9a2-07395a5ec88c';
const MS_TENANT_ID = process.env.TENANT_ID ;

// Configure jwks-rsa client for Microsoft Identity Platform keys
// Use tenant-specific endpoint if TENANT_ID is available, otherwise use common
const jwksUri = MS_TENANT_ID 
  ? `https://login.microsoftonline.com/${MS_TENANT_ID}/discovery/v2.0/keys`
  : `https://login.microsoftonline.com/common/discovery/v2.0/keys`;

const client = jwksClient({
  jwksUri: jwksUri
});

// Helper function to get the signing key
function getKey(header, callback){
  client.getSigningKey(header.kid, function(err, key) {
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

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
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  try{

  const user = getDemoUser(username, password);
  if (user) {
    const token = jwt.sign({ userId: user.userId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: { username },
      message: 'Login successful'
    });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
  }
});

// POST /api/auth/o-auth-ms - Microsoft OAuth ID token verification
router.post('/auth/o-auth-ms', (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: 'Missing idToken' });
  }

  if (!MS_CLIENT_ID) {
    console.error('CLIENT_ID not configured in .env');
    return res.status(500).json({ success: false, message: 'Server configuration error' });
  }
  
  jwt.verify(idToken, getKey, { audience: MS_CLIENT_ID }, (err, decoded) => {
    if (err) {
      console.error('ID token verification failed:', err.message);
      return res.status(401).json({ success: false, message: 'Invalid ID token' });
    }

    // Extract user information from the decoded token payload
    const userId = decoded.oid || decoded.sub; // OID is preferred, fallback to sub
    const email = decoded.preferred_username || decoded.email;
    const name = decoded.name;
    const role = 'admin'; // Default role for OAuth users, adjust if needed

    if (!userId || !email || !name) {
         console.error('Required user info missing in ID token payload', decoded);
         return res.status(401).json({ success: false, message: 'Incomplete user information in token' });
    }

    // Issue a new application JWT
    // const appToken = jwt.sign(
    //   { userId, email, name, role }, 
    //   JWT_SECRET, 
    //   { expiresIn: '1h' } // Token valid for 1 hour
    // );
    const token = jwt.sign({ userId, role, email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      user: { username:name },
      message: 'Login successful'
    });

    // res.json({ token: appToken });
  });
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
  await redis.lpush(`user:sessions:${req.user.userId}`, sessionId);
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
        return res.status(400).json({ success: false, message: 'Missing userId' });
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
    res.status(500).json({ success: false, message: 'Oops! Something went wrong, Contact Support at support@example.com' });
  }
});


export default router; 