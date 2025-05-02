import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import XLSX from 'xlsx';
import streamJsonPkg from 'stream-json';
import streamArrayPkg from 'stream-json/streamers/StreamArray.js';
const { parser } = streamJsonPkg;
const { streamArray } = streamArrayPkg;

const router = express.Router();
const TEMP_DIR = path.resolve('temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Use multer for streaming file upload
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB limit

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Read the uploaded file as a buffer
    const data = fs.readFileSync(req.file.path);
    const workbook = XLSX.read(data, {
      type: 'buffer',
      cellNF: true,
      cellDates: true,
      cellText: false,
    });

    const allJsonData = {};

    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(sheet, {
        raw: true,
        defval: '',
        blankrows: true,
      });

      // Detect date columns
      const dateColumns = new Set();
      const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
      for (let R = range.s.r + 1; R <= Math.min(range.e.r, range.s.r + 5); ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
          const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = sheet[cellRef];
          const headerCell = XLSX.utils.encode_cell({ r: range.s.r, c: C });
          const header = sheet[headerCell]?.v;
          if (
            cell &&
            header &&
            (cell.t === 'd' || (cell.t === 'n' && cell.z && cell.z.includes('yy')))
          ) {
            dateColumns.add(header);
          }
        }
      }

      // Format only the detected date columns
      const formattedData = jsonData.map(row => {
        const newRow = {};
        for (const key in row) {
          const value = row[key];
          if (dateColumns.has(key) && value) {
            try {
              newRow[key] = XLSX.SSF.format('dd/mm/yyyy', value);
            } catch {
              newRow[key] = value;
            }
          } else {
            newRow[key] = value;
          }
        }
        return newRow;
      });

      allJsonData[sheetName] = formattedData;
    });

    // Save the result as a temp file
    const resultFileName = `${uuidv4()}_excel.json`;
    const resultFilePath = path.join(TEMP_DIR, resultFileName);
    fs.writeFileSync(resultFilePath, JSON.stringify(allJsonData));

    // Remove the uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ file: resultFileName, message: 'Excel parsed and saved.' });
  } catch (err) {
    fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process Excel file', details: err.message });
  }
});

export default router; 