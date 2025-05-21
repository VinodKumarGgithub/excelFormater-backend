import pino from 'pino';

// Determine if in production environment
const isProduction = process.env.NODE_ENV === 'production';

// Configure logger based on environment
const logger = pino({
  level: isProduction ? 'info' : 'debug',
  transport: isProduction 
    ? undefined 
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      },
  // In production, use a more concise format
  formatters: isProduction ? {
    level: (label) => ({ level: label })
  } : undefined
});

// Middleware to log requests and responses
export const requestLogger = (req, res, next) => {
  const startTime = process.hrtime();

// Base log info (always included)
const logParts = [
  `Request:`,
  `${req.method} ${req.originalUrl}`,
  `ip: ${req.headers['x-client-ip'] ||req.ip}`
];

// Extra details for development only (included only if present)
if (!isProduction) {
  const extraHeaders = [
    req.headers['x-forwarded-for'] && `x-forwarded-for: ${req.headers['x-forwarded-for']}`,
    req.headers['x-real-ip'] && `x-real-ip: ${req.headers['x-real-ip']}`,
    req.headers['x-forwarded-proto'] && `x-forwarded-proto: ${req.headers['x-forwarded-proto']}`,
    req.headers['user-agent'] && `user-agent: ${req.headers['user-agent']}`
  ].filter(Boolean);

  logParts.push(...extraHeaders);
}

logger.info(logParts.join(' | '));

  // Capture the original end to extend its behavior
  const originalEnd = res.end;
  
  res.end = function(...args) {
    // Calculate duration in milliseconds
    const [seconds, nanoseconds] = process.hrtime(startTime);
    const duration = (seconds * 1000) + (nanoseconds / 1000000);
    const logParts = [
      `Response:`,
      `${req.method} ${req.originalUrl}`,
      `status: ${res.statusCode}`,
      `duration: ${duration.toFixed(2)}ms`
    ];
    // Log response
    logger.info(logParts.join(' | '));
    originalEnd.apply(res, args);
  };
  
  next();
};

// Middleware to log errors
export const errorLogger = (err, req, res, next) => {
  logger.error(`Error: ${err.message}`);
  next(err);
};

export default logger; 