const allowedIPs = process.env.ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1', '192.168.1.100', '45.74.39.250'];

export const checkIP = (req, res, next) => {
  // const ip = req.ip || req.connection.remoteAddress;
  // if admin/queues, skip ip check
  if (req.path.startsWith('/admin/queues')) {
    return next();
  }
  const ip = req.headers['x-client-ip'] || req.ip;
  if (allowedIPs?.includes(ip)) {
    return next();
  }
  return res.status(403).json({ success: false, message: `Access denied: IP address is not allowed.` });
};
