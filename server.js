import express from 'express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import cors from 'cors';

// Import configurations
import { ENV } from './lib/config/appConfig.js';
import redis from './lib/config/redisConfig.js';
import { logger } from './lib/services/loggerService.js';

// Import routes
import jobsRouter from './routes/jobs.js';
import logsRouter from './routes/logs.js';
import sessionsRouter from './routes/sessions.js';
import metricsRouter from './routes/metrics.js';

const app = express();
const port = ENV.PORT;
const batchQueue = new Queue('batchQueue', { connection: redis });

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

// Start server
app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
  logger.info(`Bull Board available at http://localhost:${port}/admin/queues`);
});