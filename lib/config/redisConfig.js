/**
 * Redis configuration and connection management
 */
import Redis from 'ioredis';

// Use console for logging to avoid circular dependency
// since logger depends on redis and redis would depend on logger
// Later in application code we'll use the proper logger

/**
 * Create Redis client with connection retry strategy
 * @returns {Redis} - Redis client instance
 */
function createRedisClient() {
  const client = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    
    // Retry with exponential backoff (50ms -> 100ms -> 200ms ... up to 2s max)
    retryStrategy(times) {
      const delay = Math.min(50 * Math.pow(2, times), 2000);
      console.log(`🔄 Redis reconnect attempt #${times}, retrying in ${delay}ms`);
      return delay;
    },
  });

  // Set up event handlers
  client.on('connect', () => {
    console.log('✅ Redis connected');
  });

  client.on('error', (err) => {
    console.error('❌ Redis error:', err);
  });

  client.on('close', () => {
    console.warn('⚠️ Redis connection closed');
  });

  return client;
}

// Create and export a singleton Redis client
const redis = createRedisClient();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await redis.quit();
  console.log('🛑 Redis connection closed due to app termination');
  process.exit(0);
});

export default redis; 