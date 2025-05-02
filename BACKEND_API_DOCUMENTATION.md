# Backend API Documentation

## Overview
This backend is designed for large-scale data processing, supporting:
- Batch job queueing and background processing
- Large JSON and Excel file ingestion and transformation
- Temporary file storage and download
- Session and job management via Redis and BullMQ

---

## Architecture

```
src/
├── api/            # API route handlers
├── bull/           # BullMQ queue and board
├── middleware/     # Express middleware
├── redis/          # Redis connection
├── utils/          # Utility functions
├── worker.js       # Background job processor
└── server.js       # Main Express app entry point
```

---

## Key Features
- Handles very large JSON and Excel files (hundreds of MBs)
- Streams uploads to disk to avoid memory overload
- Background job processing for heavy tasks
- Temporary file storage with download endpoints
- Session and batch management via Redis and BullMQ
- Customizable transformation logic (e.g., prefixing IDs)

---

## API Endpoints

### 1. Session Management
#### `POST /api/init-session`
Initialize a session for batch processing.

**Request:**
```json
{
  "apiUrl": "https://api.example.com/endpoint",
  "auth": { "userId": "user", "apiKey": "key" }
}
```
**Response:**
```json
{ "sessionId": "session:..." }
```

---

### 2. Batch Queueing
#### `POST /api/queue-batch`
Queue a batch of records for background processing.

**Request:**
```json
{
  "sessionId": "session:...",
  "records": [ { ... }, { ... } ]
}
```
**Response:**
```json
{ "status": "queued" }
```

---

### 3. Worksheet Processing
#### `POST /api/process-worksheet`
Transform an array of worksheet data.

**Request:**
```json
{
  "data": [ { ... }, { ... } ]
}
```
**Response:**
```json
{
  "result": [ { ...transformed... }, ... ]
}
```

---

### 4. Large JSON Transformation
#### `POST /api/transform-large-json?prefix=MYPROJECT`
Upload a large JSON array, transform it, and save the result as a temp file.
- **Body:** Raw JSON array (not multipart)
- **Query:** `prefix` (optional, default: `POC`)

**Request Example (JS):**
```js
fetch('/api/transform-large-json?prefix=MYPROJECT', {
  method: 'POST',
  body: new Blob([JSON.stringify(largeArray)], { type: 'application/json' }),
  headers: { 'Content-Type': 'application/json' }
});
```
**Response:**
```json
{ "file": "MYPROJECT_...jsonl", "message": "Transformation complete." }
```

---

### 5. Excel File Upload & Parsing
#### `POST /api/upload-excel`
Upload a large Excel file, parse and format it, and save as a temp JSON file.
- **Body:** `multipart/form-data` with `file` field

**Request Example (JS):**
```js
const formData = new FormData();
formData.append('file', file);
fetch('/api/upload-excel', { method: 'POST', body: formData });
```
**Response:**
```json
{ "file": "...._excel.json", "message": "Excel parsed and saved." }
```

---

### 6. File Download
#### `GET /api/download-temp/:filename`
Download a previously generated temp file.

**Request:**
```
GET /api/download-temp/MYPROJECT_...jsonl
```
**Response:**  
- File download (JSONL or JSON)

---

## Use Cases & Examples

### 1. Batch Data Processing
- Upload a large array of records (JSON or Excel).
- Transform and normalize data (e.g., for insurance claims, medical records).
- Download the processed result for further use.

### 2. Excel Data Normalization
- Upload a multi-sheet Excel file.
- Automatically detect and format date columns.
- Download a clean, normalized JSON file for analytics or import.

### 3. Background API Integration
- Queue batches of records for background API calls (e.g., to a third-party service).
- Track job progress and logs via Bull Board.

### 4. Session-based Processing
- Initialize a session with API credentials.
- Queue multiple batches under the same session for consistent processing.

---

## Security & Performance
- Uploads are streamed to disk (not held in memory).
- File size limits (default: 200MB, configurable).
- No authentication by default (add for production!).
- CORS is open (lock down for production).
- Temp files are not auto-cleaned (add a cron job or TTL for cleanup).
- Path traversal is not prevented in download endpoint (sanitize input).

---

## Best Practices & Recommendations
- Increase file size limits only if your server has enough RAM for parsing.
- Add authentication for all endpoints in production.
- Validate all inputs (use a schema validator).
- Sanitize file names in download endpoint to prevent path traversal.
- Monitor temp directory and clean up old files regularly.
- Use environment variables for all configuration (port, limits, Redis URL, etc.).
- Add logging and monitoring for production deployments.

---

## Extending & Scaling
- For even larger files: Use a streaming Excel parser (e.g., `exceljs` streaming API) and process rows in batches.
- For distributed processing: Store temp files in a shared location (e.g., S3) and run multiple worker nodes.
- For job tracking: Expose job status endpoints and integrate with Bull Board UI.
- For security: Add JWT or OAuth authentication, and restrict CORS.

---

## Example Workflow

### Excel Upload and Download
1. **User uploads Excel file:**
   ```js
   const formData = new FormData();
   formData.append('file', file);
   const res = await fetch('/api/upload-excel', { method: 'POST', body: formData });
   const { file } = await res.json();
   ```
2. **User downloads parsed JSON:**
   ```js
   window.open(`/api/download-temp/${file}`);
   ```

### Large JSON Transformation
1. **User uploads large JSON array:**
   ```js
   const blob = new Blob([JSON.stringify(largeArray)], { type: 'application/json' });
   const res = await fetch('/api/transform-large-json?prefix=MYPROJECT', { method: 'POST', body: blob });
   const { file } = await res.json();
   ```
2. **User downloads transformed file:**
   ```js
   window.open(`/api/download-temp/${file}`);
   ```

---

## Contact & Support
- For questions, bug reports, or feature requests, contact the backend maintainers or open an issue in your project repository. 