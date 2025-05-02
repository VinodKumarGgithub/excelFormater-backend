import express from 'express';
import createCorsMiddleware from './middleware/cors.js';
import { serverAdapter } from './bull/bullBoard.js';
import processWorksheetRouter from './api/processWorksheet.js';
import initSessionRouter from './api/initSession.js';
import queueBatchRouter from './api/queueBatch.js';
import transformLargeJsonRouter from './api/transformLargeJson.js';
import downloadTempRouter from './api/downloadTemp.js';
import uploadExcelRouter from './api/uploadExcel.js';

const app = express();
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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Bull Board at http://localhost:${port}/admin/queues`);
}); 