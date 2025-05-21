const allowedIPs = process.env.ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1', '192.168.1.100'];

export const checkIP = (req, res, next) => {
  // const ip = req.ip || req.connection.remoteAddress;
  const ip = req.headers['x-client-ip'] || req.ip;
  if (allowedIPs?.includes(ip)) {
    return next();
  }
  return res.status(403).send('Forbidden');
};
