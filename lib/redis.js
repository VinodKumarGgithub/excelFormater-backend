import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB) || 0,

  // Retry strategy: exponential backoff with cap
  retryStrategy: (attempts) => {
    if (attempts > 10) {
      console.error('🛑 Redis retry limit reached. No more attempts.');
      return null; // Stop retrying
    }
    const delay = Math.min(attempts * 1000, 2000); // max 2s
    console.warn(`🔁 Redis retrying in ${delay}ms (attempt ${attempts})`);
    return delay;
  },

  reconnectOnError: (err) => {
    const shouldReconnect = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'].some(code =>
      err.message.includes(code)
    );
    if (shouldReconnect) {
      console.warn('♻️ Reconnecting due to Redis error:', err.message);
    }
    return shouldReconnect;
  }
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

export default redis;
