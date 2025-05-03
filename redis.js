import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,

  // Retry with exponential backoff (50ms -> 100ms -> 200ms ... up to 2s max)
  retryStrategy(times){
    const delay = Math.min(50 * Math.pow(2, times), 2000);
    console.log(`🔄 Redis reconnect attempt #${times}, retrying in ${delay}ms`);
    return delay;
  },
});


redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

redis.on('close', () => {
  console.warn('⚠️ Redis connection closed');
});

process.on('SIGINT', async () => {
  await redis.quit();
  console.log('🛑 Redis connection closed due to app termination');
  process.exit(0);
});

export default redis;
