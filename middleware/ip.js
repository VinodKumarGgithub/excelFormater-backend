import redis from '../lib/redis.js';

export const checkIP = async (req, res, next) => {
  // const ip = req.ip || req.connection.remoteAddress;
  if(process.env.NODE_ENV === 'development') {
    return next();
  }
  // if admin/queues, skip ip check
  if (req.path.startsWith('/admin/queues')) {
    return next();
  }
  
  try {
    const ip = req.headers['x-client-ip'] || req.ip;
    // Read allowed IPs from Redis Set
    const allowedIPsSet = await redis.smembers('allowedIps:ipv4');

    // Include hardcoded/env IPs for backward compatibility or initial seeding if the set is empty
    const defaultAllowedIPs = process.env.ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1', '45.74.39.250'];
    const allAllowedIPs = new Set([...allowedIPsSet, ...defaultAllowedIPs]);

    if (allAllowedIPs.has(ip)) {
      return next();
    }
    return res.status(403).json({ success: false, message: `Access denied: IP address ${ip} is not allowed.` });
  } catch (err) {
    console.error('Error checking IP against Redis:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during IP check.' });
  }
};
