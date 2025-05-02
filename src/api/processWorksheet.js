import express from 'express';
import { processWorksheet } from '../utils/worksheet.js';

const router = express.Router();

router.post('/', (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Missing or invalid data array' });
  }
  try {
    const result = processWorksheet(data);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: 'Processing failed', details: err.message });
  }
});

export default router; 