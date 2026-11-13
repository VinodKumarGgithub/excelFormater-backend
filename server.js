import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import cors from 'cors';

// Import configurations
import { ENV } from './lib/config/appConfig.js';
import redis from './lib/config/redisConfig.js';
import { logger } from './lib/services/loggerService.js';

// Import services & db
import workerPool from './lib/services/workerPool.js';
import { getBatchQueue } from './lib/services/queueService.js';
import sequelize from './lib/config/db.js';
import bcrypt from 'bcryptjs';
import User from './lib/models/User.js';
import Session from './lib/models/Session.js';
import ApiLog from './lib/models/ApiLog.js';

// Import routes
import jobsRouter from './routes/jobs.js';
import logsRouter from './routes/logs.js';
import sessionsRouter from './routes/sessions.js';
import metricsRouter from './routes/metrics.js';
import errorsRouter from './routes/errors.js';

const app = express();
const port = ENV.PORT;
const batchQueue = getBatchQueue();

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(batchQueue)],
  serverAdapter,
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/admin/queues', serverAdapter.getRouter());
app.use('/api', sessionsRouter);
app.use('/api', jobsRouter);
app.use('/api', logsRouter);
app.use('/api', metricsRouter);
app.use('/api', errorsRouter);

// Add health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    time: new Date().toISOString(),
    workerPool: {
      initialized: workerPool.initialized,
      workers: workerPool.size
    }
  });
});

// Initialize worker pool for API calls - this will make APIs more responsive
workerPool.initialize().then(() => {
  logger.info('Worker pool initialized on server startup');
}).catch(err => {
  logger.error({ error: err.message }, 'Failed to initialize worker pool on startup');
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down server');
  
  try {
    // Shut down worker pool
    await workerPool.shutdown();
    await sequelize.close();
    logger.info('Worker pool and DB shutdown complete');
  } catch (err) {
    logger.error({ error: err.message }, 'Error shutting down');
  }
  
  process.exit(0);
});

// Database initialization
async function initDatabase() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection has been established successfully.');
    
    // Sync models
    await sequelize.sync({ alter: true });
    logger.info('Database models synchronized.');

    // Seed admin
    const adminCount = await User.count({ where: { role: 'ADMIN' } });
    if (adminCount === 0) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await User.create({
        username: 'admin',
        password: hashedPassword,
        role: 'ADMIN',
        status: 'ACTIVE'
      });
      logger.info('Default ADMIN user (admin / password123) successfully seeded.');
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Unable to initialize database');
  }
}

// Start sequence
try {
  await initDatabase();
  app.listen(port, () => {
    logger.info(`Server running at http://localhost:${port}`);
    logger.info(`Bull Board available at http://localhost:${port}/admin/queues`);
  });
} catch (error) {
  logger.error({ error: error.message }, 'Server failed to start');
  process.exit(1);
}
