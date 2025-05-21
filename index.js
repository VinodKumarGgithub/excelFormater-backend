import app from './server.js';
import dotenv from 'dotenv';
dotenv.config();

const port = 3000;

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Bull Board at http://localhost:${port}/admin/queues`);
});

