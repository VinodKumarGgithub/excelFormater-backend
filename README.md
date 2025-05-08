# Excel Formatter Backend

A high-performance backend for processing Excel data with optimized API calling capabilities.

## Features

- Batch processing of Excel records
- Worker thread pool for improved API performance
- Auto-scaling based on workload and error rates
- Circuit breaker pattern to prevent cascading failures
- Comprehensive metrics and monitoring

## Worker Pool Implementation

This application uses a worker thread pool to improve API calling performance. The worker pool offloads CPU-intensive tasks like API calls to background threads, which prevents blocking the main thread and improves overall system throughput.

### Key Components

- `lib/services/workerPool.js`: The main worker pool implementation that manages worker threads
- `lib/workers/apiWorker.js`: The worker thread script that handles API requests
- `lib/services/processRecord.js`: Service that uses the worker pool for API calls
- `worker.js`: Main BullMQ worker that processes batches using the worker pool

## Performance Benefits

- **Parallel Processing**: Multiple API calls can be executed in parallel
- **Non-Blocking**: API calls don't block the main thread, improving responsiveness
- **Error Isolation**: Errors in one worker don't affect others
- **Auto-Scaling**: The pool adjusts based on workload and system resources
- **Resilience**: Built-in retry mechanisms and circuit breaker patterns

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Configure Redis (using Docker):
   ```
   docker run -p 6379:6379 redis
   ```

3. Start the server:
   ```
   npm run start
   ```

4. Start the worker:
   ```
   npm run worker
   ```

## Testing the Worker Pool

### Performance Test Endpoint

The application includes a performance test endpoint to compare the worker pool's performance with direct API calls:

```bash
curl -X POST http://localhost:3000/api/metrics/performance-test \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://jsonplaceholder.typicode.com/posts",
    "method": "GET",
    "iterations": 20
  }'
```

### Monitoring Worker Pool Status

```bash
curl http://localhost:3000/api/metrics/worker-pool
```

### Viewing Performance Metrics

```bash
curl http://localhost:3000/api/metrics/api
```

## API Endpoints

- `POST /api/sessions`: Create a new processing session
- `POST /api/jobs`: Submit a batch job
- `GET /api/jobs/:jobId`: Get job status
- `GET /api/logs/:sessionId`: Get session logs
- `GET /api/metrics/api`: Get API performance metrics
- `GET /api/metrics/worker-pool`: Get worker pool status
- `POST /api/metrics/performance-test`: Run a performance test

### Error Handling Endpoints

- `GET /api/errors/summary`: Get summary statistics for all error categories
- `GET /api/errors/user-action/:sessionId`: Get all user action errors for a session
- `POST /api/errors/user-action/:errorId/resolve`: Mark a user action error as resolved 
- `POST /api/errors/user-action/:errorId/reprocess`: Reprocess a record with corrected data
- `DELETE /api/errors/user-action/:sessionId`: Clear all user action errors for a session

## Worker Pool Architecture

```
┌────────────────┐      ┌────────────────┐
│                │      │                │
│    Server.js   │◄────►│   Worker.js    │
│                │      │                │
└───────┬────────┘      └────────┬───────┘
        │                        │
        │                        │
        ▼                        ▼
┌────────────────┐      ┌────────────────┐
│                │      │                │
│  Worker Pool   │◄────►│  Process Jobs  │
│                │      │                │
└───────┬────────┘      └────────┬───────┘
        │                        │
        │                        │
        ▼                        ▼
┌────────────────┐      ┌────────────────┐
│                │      │                │
│  API Workers   │◄────►│  Redis Cache   │
│                │      │                │
└────────────────┘      └────────────────┘
```

## Handling API Errors

The system categorizes API errors to provide appropriate handling strategies:

### Error Categories

- **REQUIRES_USER_ACTION**: 4XX errors that require user intervention (400, 403, 404, 409, 422)
- **TEMPORARY_FAILURE**: Temporary errors that may resolve with retries (429)
- **SYSTEM_ERROR**: Server-side errors (5XX)
- **NETWORK_ERROR**: Connection or timeout issues
- **AUTH_ERROR**: Authentication or authorization issues (401, 403)
- **UNKNOWN_ERROR**: Unclassified errors

### User Action Errors (4XX)

When an API returns a 4XX error that requires user intervention, the system:

1. Categorizes the error and extracts detailed information
2. Stores the error with the full record context in Redis
3. Makes the error available through the API for later resolution
4. Continues processing other records in the batch

### Resolving User Action Errors

The application provides endpoints to view and resolve user action errors:

```bash
# Get all user action errors for a session
GET /api/errors/user-action/:sessionId

# Resolve a specific error with corrected data
POST /api/errors/user-action/:errorId/resolve

# Reprocess a record with corrected data
POST /api/errors/user-action/:errorId/reprocess

# Clear all user action errors for a session
DELETE /api/errors/user-action/:sessionId
```

### Example: Resolving a Validation Error

1. **View the error details**:
   ```bash
   curl http://localhost:3000/api/errors/user-action/session123
   ```

2. **Fix the data and reprocess**:
   ```bash
   curl -X POST http://localhost:3000/api/errors/user-action/error123/reprocess \
     -H "Content-Type: application/json" \
     -d '{
       "record": {
         "id": "ABC123",
         "name": "Fixed Value",  
         "amount": 50
       },
       "apiUrl": "https://api.example.com/endpoint"
     }'
   ```

3. **Mark as resolved manually**:
   ```bash
   curl -X POST http://localhost:3000/api/errors/user-action/error123/resolve \
     -H "Content-Type: application/json" \
     -d '{
       "status": "resolved",
       "resolution": "Fixed incorrect data format",
       "action": "manual_fix"
     }'
   ```

## Performance Tips

1. Adjust the worker pool size in `workerPool.js` based on your system's CPU count
2. Use batch processing for large datasets
3. Monitor API call performance using the metrics endpoints
4. Implement caching for frequently requested data
5. Tune rate limiting parameters in `rateLimit.js` if needed

## Project Structure

The project follows a modular structure for better organization and maintainability:

```
.
├── lib/                    # Core application logic
│   ├── config/             # Configuration files
│   │   ├── appConfig.js    # Application configuration settings
│   │   └── redisConfig.js  # Redis connection configuration
│   ├── constants/          # Constant definitions
│   │   ├── api.js          # API-related constants
│   │   └── concurrency.js  # Concurrency management constants
│   ├── helpers/            # Helper functions
│   │   ├── auth.js         # Authentication helpers
│   │   ├── metrics.js      # Metrics collection and analysis
│   │   └── validation.js   # Data validation helpers
│   └── services/           # Core services
│       ├── apiClient.js    # Enhanced API client with metrics
│       ├── concurrencyManager.js # Dynamic concurrency management
│       ├── loggerService.js # Structured logging service
│       ├── processRecord.js # Record processing with retries
│       ├── queueManager.js  # Queue management functions
│       └── rateLimit.js     # Rate limiting service
├── routes/                 # API routes
│   ├── jobs.js             # Job management endpoints
│   ├── logs.js             # Log retrieval endpoints
│   ├── metrics.js          # Metrics endpoints
│   └── sessions.js         # Session management and auth
├── logs/                   # Log files directory
├── .env                    # Environment variables
├── .gitignore              # Git ignore file
├── ecosystem.config.cjs    # PM2 configuration
├── logger.js               # Legacy logger (for backwards compatibility)
├── package.json            # Project dependencies
├── redis.js                # Legacy Redis connector (for backwards compatibility)
├── server.js               # Express server setup
├── utils.js                # Legacy utilities (for backwards compatibility)
└── worker.js               # Worker process for job processing
```

## Architecture

The application uses a modular architecture with clean separation of concerns:

- **Config**: Central repository for application configuration
- **Constants**: Application-wide constants and parameters
- **Helpers**: Utility functions for common operations
- **Services**: Core business logic implementation
- **Routes**: API endpoints for external interaction

## Legacy Files

The following files are maintained for backward compatibility and will be removed in future versions:

- `logger.js`: Re-exports from `lib/services/loggerService.js`
- `redis.js`: Re-exports from `lib/config/redisConfig.js`
- `utils.js`: Re-exports helpers and services from the lib/ directory

It's recommended to import directly from the modular structure instead of using these legacy files.

## Getting Started

1. Install dependencies:
   ```
   npm install
   ```

2. Configure environment variables in `.env` file.

3. Start the application:
   ```
   npm start
   ```

4. For development with auto-restart:
   ```
   npm run dev
   ```

## Deployment

For production deployment, you can use the included PM2 configuration:

```
pm2 start ecosystem.config.cjs
``` 