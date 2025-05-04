/**
 * Application configuration settings
 */

// Environment configurations
export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  JWT_SECRET: process.env.JWT_SECRET || 'sd@!v@#$%^&*()_+',
};

// Default authentication settings
export const AUTH = {
  DEMO_USER: { 
    username: process.env.DEMO_USERNAME || 'admin', 
    password: process.env.DEMO_PASSWORD || 'password123' 
  },
  TOKEN_EXPIRY: '7d'
};

// API settings
export const API = {
  RATE_LIMIT: {
    MAX_REQUESTS: 100,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
  TIMEOUT_MS: 10000, // 10 seconds
};

// Queue settings
export const QUEUE = {
  DEFAULT_JOB_OPTIONS: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,    // Keep the latest 1000 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600 // Keep failed jobs for 7 days
    }
  },
  SESSION_TTL: 604800 // 1 week in seconds
};

// File system settings
export const FILE_SYSTEM = {
  LOG_DIR: './logs'
}; 