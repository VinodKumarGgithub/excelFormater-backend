import express from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import StreamJson from 'stream-json';
import StreamArrayPkg from 'stream-json/streamers/StreamArray.js';

const { parser } = StreamJson;
const { streamArray } = StreamArrayPkg;

import { processWorksheet } from '../utils/worksheet.js';

const router = express.Router();
const TEMP_DIR = path.resolve('temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

router.post('/', (req, res) => {
  // Accept prefix from query or body
  let prefix = req.query.prefix;
  if (!prefix && req.headers['content-type']?.includes('application/json')) {
    // If JSON, try to get prefix from body (if sent separately)
    prefix = req.body?.prefix;
  }
  prefix = prefix || 'POC';

  const rawFileName = `${prefix}_${uuidv4()}-raw.json`;
  const rawFilePath = path.join(TEMP_DIR, rawFileName);
  const resultFileName = `${prefix}_${uuidv4()}.jsonl`;
  const resultFilePath = path.join(TEMP_DIR, resultFileName);

  // 1. Stream upload to temp file
  const rawFile = fs.createWriteStream(rawFilePath);
  req.pipe(rawFile);

  rawFile.on('finish', () => {
    // 2. After upload, read and transform
    const objects = [];
    fs.createReadStream(rawFilePath)
      .pipe(parser())
      .pipe(streamArray())
      .on('data', ({ value }) => {
        objects.push(value);
      })
      .on('end', () => {
        try {
          // Pass prefix to processWorksheet
          const transformed = processWorksheet(objects, prefix);
          const output = fs.createWriteStream(resultFilePath);
          for (const obj of transformed) {
            output.write(JSON.stringify(obj) + '\n');
          }
          output.end();

          // 3. Remove the raw temp file
          fs.unlink(rawFilePath, () => {});
          res.json({ file: resultFileName, message: 'Transformation complete.' });
        } catch (err) {
          fs.unlink(rawFilePath, () => {});
          res.status(500).json({ error: 'Transformation error', details: err.message });
        }
      })
      .on('error', err => {
        fs.unlink(rawFilePath, () => {});
        res.status(500).json({ error: 'Streaming error', details: err.message });
      });
  });

  rawFile.on('error', err => {
    res.status(500).json({ error: 'Upload error', details: err.message });
  });
});

export default router; 