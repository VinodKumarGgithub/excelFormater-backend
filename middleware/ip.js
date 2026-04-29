import constance from '../config/constance.js';
import redis from '../lib/redis.js';
import AllowedIP from '../models/AllowedIP.js';

// Helper: check if an IP is in the allowlist (Redis + DB + env fallback)
export async function isIPAllowed(ip) {
  const allowedIPsSet = await redis.smembers('allowedIps:ipv4');
  const allowedIPsDB = await AllowedIP.findAll({
    where: { isActive: true },
    attributes: ['ip']
  });
  const defaultAllowedIPs = process.env.ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1', '45.74.39.250'];
  const allAllowedIPs = new Set([...allowedIPsSet, ...defaultAllowedIPs, ...allowedIPsDB.map(r => r.ip)]);
  return allAllowedIPs.has(ip);
}

export const checkIP = async (req, res, next) => {
  if(process.env.NODE_ENV === 'development' || req.method === 'OPTIONS') {
    return next();
  }
  // skip ip check for public routea
  if (constance.publicPath.some(path => req.path.includes(path))) {
    return next();
  }
  
  try {
    const ip = req.headers['x-client-ip'] || req.ip;
    if (await isIPAllowed(ip)) {
      return next();
    }
    return res.status(403).json({ success: false, message: `Access denied: IP address ${ip} is not allowed.` });
  } catch (err) {
    console.error('Error checking IP against Redis:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during IP check.' });
  }
};
