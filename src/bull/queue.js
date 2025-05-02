import { Queue } from 'bullmq';
import redis from '../redis/client.js';

export const batchQueue = new Queue('batchQueue', { connection: redis }); 