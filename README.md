# Excel Formatter Backend

A microservice for processing and formatting Excel data with adaptive concurrency management and comprehensive logging.

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