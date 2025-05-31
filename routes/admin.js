import express from 'express';
import redis from '../lib/redis.js';
import { authenticateJWT } from './sessions.js';
import ipPkg from 'ip';

const router = express.Router();

// Protect all admin routes
router.use(authenticateJWT);

// Middleware to check for admin role
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Access denied: Admins only.' });
  }
};

// Apply isAdmin middleware to all routes in this router
router.use(isAdmin);

// POST /api/admin/allowed-ips - Add an IPv4 address to the allowed list
router.post('/allowed-ips', async (req, res) => {
  const { ip, deviceId } = req.body;

  if (!ip) {
    return res.status(400).json({ success: false, message: 'IP address is required.' });
  }

  // Validate IPv4 address using the 'ip' package
  if (!ipPkg.isV4Format(ip)) {
    return res.status(400).json({ success: false, message: 'Invalid IPv4 address format.' });
  }

  try {
    // Add the IP to the Redis Set. Sets automatically handle uniqueness.
    await redis.sadd('allowedIps:ipv4', ip);

    // Optional: Store device ID if provided (e.g., in a hash indexed by IP)
    if (deviceId) {
        await redis.hset('allowedIps:ipv4:devices', ip, deviceId);
    }

    res.json({ success: true, message: `IP address ${ip} added to allowed list.`, deviceId });
  } catch (err) {
    console.error('Error adding allowed IP to Redis:', err);
    res.status(500).json({ success: false, message: 'Failed to add allowed IP.' });
  }
});

// GET /api/admin/allowed-ips - Get all allowed IPv4 addresses
router.get('/allowed-ips', async (req, res) => {
  try {
    // Get all members from the Redis Set
    const allowedIPs = await redis.smembers('allowedIps:ipv4');

    // Get device IDs if stored
    const deviceIds = await redis.hgetall('allowedIps:ipv4:devices');

    // Combine IPs with device IDs
    const ipList = allowedIPs.map(ip => ({
      ip: ip,
      deviceId: deviceIds[ip] || null // Attach device ID if found, otherwise null
    }));

    res.json({ success: true, count: ipList.length, ipList });
  } catch (err) {
    console.error('Error retrieving allowed IP list from Redis:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve allowed IP list.' });
  }
});

export default router; 