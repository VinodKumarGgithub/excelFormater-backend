import express from 'express';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const TEMP_DIR = path.resolve('temp');

router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath, err => {
    if (err) res.status(500).json({ error: 'Download failed', details: err.message });
  });
});

export default router; 