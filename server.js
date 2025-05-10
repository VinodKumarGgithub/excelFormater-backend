import express from 'express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
// import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';

import { ExpressAdapter } from '@bull-board/express';
import redis from './redis.js';
import cors from 'cors';
import jobsRouter from './routes/jobs.js';
import sessionsRouter from './routes/sessions.js';
import apiContextRouter from './routes/api-context.js';

const app = express();
const port = 3000;
const batchQueue = new Queue('batchQueue', { connection: redis });

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(batchQueue)],
  serverAdapter,
});

app.use(cors());
app.use(express.json());
app.use('/admin/queues', serverAdapter.getRouter());
app.use('/api', sessionsRouter);
app.use('/api', jobsRouter);
app.use('/api', apiContextRouter);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Bull Board at http://localhost:${port}/admin/queues`);
});