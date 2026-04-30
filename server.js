import express from 'express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import basicAuth from 'express-basic-auth';
import { checkIP } from './middleware/ip.js';
// import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';

import { ExpressAdapter } from '@bull-board/express';
import redis from './lib/redis.js';
import cors from 'cors';
import jobsRouter from './routes/jobs.js';
import sessionsRouter from './routes/sessions.js';
import apiContextRouter from './routes/api-context.js';
import { requestLogger, errorLogger } from './middleware/logger.js';
import { globalErrorHandler } from './middleware/error.js';
import systemHealthRouter from './routes/systemHealth.js';
import adminRouter from './routes/admin.js';
import { initializeDatabase } from './models/index.js';

const app = express();
const batchQueue = new Queue('batchQueue', { connection: redis });
const downloadQueue = new Queue('downloadQueue', { connection: redis})

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(batchQueue), new BullMQAdapter(downloadQueue)],
  serverAdapter,
});

// Apply global middleware
app.use(requestLogger); // Add request/response logging
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use('/admin/queues', basicAuth({
  users: { 'admin': 'password123' },
  challenge: true,
}))

app.use('/api', sessionsRouter);

// apply ip check for all other routes
app.use(checkIP);

app.use('/admin/queues', serverAdapter.getRouter());

app.use('/api', jobsRouter);
app.use('/api', apiContextRouter);
app.use('/api', systemHealthRouter);
app.use('/api/admin', adminRouter);

// Error handling middleware
app.use(globalErrorHandler);

// Initialize database connection
const startServer = async () => {
  try {
    const dbInitialized = await initializeDatabase();
    if (!dbInitialized) {
      console.error('❌ Failed to initialize database. Server may not function properly.');
    }
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  }
};

// Initialize database on startup
startServer();

export default app;