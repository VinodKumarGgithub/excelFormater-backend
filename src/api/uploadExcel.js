import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import XLSX from 'xlsx';
import streamJsonPkg from 'stream-json';
import streamArrayPkg from 'stream-json/streamers/StreamArray.js';
import { io } from '../server.js'; // Import the io instance
const { parser } = streamJsonPkg;
const { streamArray } = streamArrayPkg;

const router = express.Router();
const TEMP_DIR = path.resolve('temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Use multer for streaming file upload
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB limit

router.post('/', upload.single('file'), (req, res) => {
  const { socketId } = req.body; // Client should send their socketId in the form data

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
    const totalSheets = workbook.SheetNames.length;

    workbook.SheetNames.forEach((sheetName, sheetIdx) => {
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

      // Format only the detected date columns and emit row-level progress
      const formattedData = [];
      const totalRows = jsonData.length;
      jsonData.forEach((row, rowIdx) => {
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
        formattedData.push(newRow);

        // Emit progress every 10 rows or on last row
        if (socketId && (rowIdx % 10 === 0 || rowIdx === totalRows - 1)) {
          io.to(socketId).emit('excel-progress', {
            sheet: sheetName,
            row: rowIdx + 1,
            totalRows,
            percent: totalRows > 0 ? Math.round(((rowIdx + 1) / totalRows) * 100) : 100,
            message: `Processing row ${rowIdx + 1} of ${totalRows} in sheet "${sheetName}"`,
          });
        }
      });

      allJsonData[sheetName] = formattedData;
    });

    // Save the result as a temp file
    const resultFileName = `${uuidv4()}_excel.json`;
    const resultFilePath = path.join(TEMP_DIR, resultFileName);
    fs.writeFileSync(resultFilePath, JSON.stringify(allJsonData));

    // Remove the uploaded file
    fs.unlinkSync(req.file.path);

    if (socketId) {
      io.to(socketId).emit('excel-progress', {
        percent: 100,
        message: 'Excel parsing complete!',
        file: resultFileName,
      });
    }

    res.json({ file: resultFileName, message: 'Excel parsed and saved.' });
  } catch (err) {
    fs.unlinkSync(req.file.path);
    if (socketId) {
      io.to(socketId).emit('excel-progress', {
        percent: 0,
        message: 'Failed to process Excel file',
        error: err.message,
      });
    }
    res.status(500).json({ error: 'Failed to process Excel file', details: err.message });
  }
});

export default router; 