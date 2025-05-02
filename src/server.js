import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import createCorsMiddleware from './middleware/cors.js';
import { serverAdapter } from './bull/bullBoard.js';
import processWorksheetRouter from './api/processWorksheet.js';
import initSessionRouter from './api/initSession.js';
import queueBatchRouter from './api/queueBatch.js';
import transformLargeJsonRouter from './api/transformLargeJson.js';
import downloadTempRouter from './api/downloadTemp.js';
import uploadExcelRouter from './api/uploadExcel.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
const port = 3000;

app.use(createCorsMiddleware());
app.use(express.json());
app.use('/admin/queues', serverAdapter.getRouter());
// app.use('/api/process-worksheet', processWorksheetRouter);
app.use('/api/init-session', initSessionRouter);
app.use('/api/queue-batch', queueBatchRouter);
app.use('/api/transform-large-json', transformLargeJsonRouter);
app.use('/api/download-temp', downloadTempRouter);
app.use('/api/upload-excel', uploadExcelRouter);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

httpServer.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Bull Board at http://localhost:${port}/admin/queues`);
});

export { io }; 