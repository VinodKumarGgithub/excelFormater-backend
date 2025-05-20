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
const app = express();
const batchQueue = new Queue('batchQueue', { connection: redis });

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(batchQueue)],
  serverAdapter,
});

// Apply global middleware
app.use(requestLogger); // Add request/response logging
app.use(cors());
app.use(express.json());
app.use(checkIP);
app.use('/admin/queues', basicAuth({
  users: { 'admin': 'password123' },
  challenge: true,
}))
app.use('/admin/queues', serverAdapter.getRouter());
app.use('/api', sessionsRouter);
app.use('/api', jobsRouter);
app.use('/api', apiContextRouter);

// Error handling middleware
app.use(globalErrorHandler);

export default app;