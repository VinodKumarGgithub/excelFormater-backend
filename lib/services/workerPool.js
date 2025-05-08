/**
 * Worker Pool Service - Manages a pool of web workers for efficient API calling
 * Improves performance by distributing API calls across multiple workers
 */
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './loggerService.js';

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker thread script path
const WORKER_SCRIPT_PATH = path.join(__dirname, '../workers/apiWorker.js');

// Configuration
const MAX_WORKERS = Math.max(2, Math.min(cpus().length - 1, 4)); // Use between 2 and 4 workers, leaving 1 CPU for main thread
const TASK_TIMEOUT = 30000; // 30 seconds timeout for tasks

// Error categories (will be populated from worker)
const ERROR_CATEGORIES = {
  REQUIRES_USER_ACTION: 'REQUIRES_USER_ACTION',
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

class WorkerPool {
  constructor(size = MAX_WORKERS) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.workersAvailable = [];
    this.initialized = false;
    this.currentJobId = 0;
    this.jobs = new Map();
    this.errorCounts = {}; // Track error counts by category
    this.userActionErrors = []; // Store recent user action errors for reporting
    
    logger.info({ workerCount: this.size }, 'Initializing worker pool');
  }

  /**
   * Initialize the worker pool
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      for (let i = 0; i < this.size; i++) {
        const worker = new Worker(WORKER_SCRIPT_PATH);
        
        worker.on('message', (message) => {
          // Handle worker initialization with error categories
          if (message.type === 'init' && message.data?.errorCategories) {
            Object.assign(ERROR_CATEGORIES, message.data.errorCategories);
            return;
          }
          
          this.handleWorkerMessage(worker, message);
        });
        
        worker.on('error', (error) => {
          logger.error({ workerId: i, error: error.message }, 'Worker error');
          this.replaceWorker(worker);
        });
        
        this.workers.push(worker);
        this.workersAvailable.push(i);
      }
      
      this.initialized = true;
      logger.info({ status: 'ready', workers: this.size }, 'Worker pool initialized');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize worker pool');
      throw error;
    }
  }

  /**
   * Replace a failed worker
   * @param {Worker} failedWorker - The worker that failed
   */
  replaceWorker(failedWorker) {
    const index = this.workers.indexOf(failedWorker);
    if (index !== -1) {
      try {
        failedWorker.terminate();
        
        const newWorker = new Worker(WORKER_SCRIPT_PATH);
        newWorker.on('message', (message) => {
          // Handle worker initialization with error categories
          if (message.type === 'init' && message.data?.errorCategories) {
            Object.assign(ERROR_CATEGORIES, message.data.errorCategories);
            return;
          }
          
          this.handleWorkerMessage(newWorker, message);
        });
        
        newWorker.on('error', (error) => {
          logger.error({ error: error.message }, 'Worker error');
          this.replaceWorker(newWorker);
        });
        
        this.workers[index] = newWorker;
        
        // Add worker back to available list if it wasn't there
        if (!this.workersAvailable.includes(index)) {
          this.workersAvailable.push(index);
        }
        
        logger.info({ workerId: index }, 'Worker replaced');
      } catch (error) {
        logger.error({ error: error.message }, 'Failed to replace worker');
      }
    }
  }

  /**
   * Track error statistics
   * @param {Object} error - Error object to track
   */
  trackError(error) {
    if (!error) return;
    
    try {
      const category = error.category || ERROR_CATEGORIES.UNKNOWN_ERROR;
      
      // Initialize category if it doesn't exist
      if (!this.errorCounts[category]) {
        this.errorCounts[category] = 0;
      }
      
      // Increment error count
      this.errorCounts[category]++;
      
      // Store user action errors for reporting
      if (category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
        // Keep at most 100 recent user action errors
        if (this.userActionErrors.length >= 100) {
          this.userActionErrors.shift();
        }
        
        this.userActionErrors.push({
          timestamp: new Date().toISOString(),
          statusCode: error.statusCode,
          message: error.message,
          validationErrors: error.validationErrors,
          permissionInfo: error.permissionInfo,
          userActionGuidance: error.userActionGuidance,
          recordData: error.recordData
        });
      }
      
      // Log the error for monitoring
      logger.debug({
        category,
        status: error.statusCode,
        counts: this.errorCounts
      }, 'Tracked API error');
    } catch (e) {
      logger.warn('Failed to track error');
    }
  }

  /**
   * Handle messages from workers
   * @param {Worker} worker - The worker that sent the message
   * @param {Object} message - The message received
   */
  handleWorkerMessage(worker, message) {
    const { jobId, type, data, error } = message;
    const workerIndex = this.workers.indexOf(worker);
    
    if (!this.jobs.has(jobId)) {
      // Job might have been canceled or timed out
      this.workersAvailable.push(workerIndex);
      this.processQueue();
      return;
    }
    
    const { resolve, reject, timer, metadata } = this.jobs.get(jobId);
    
    // Clear the timeout timer
    if (timer) clearTimeout(timer);
    
    // Handle the message
    if (type === 'success') {
      resolve(data);
    } else if (type === 'error') {
      let errorObj;
      try {
        errorObj = typeof error === 'string' ? JSON.parse(error) : error;
        
        // Add record data to error for context if available
        if (metadata?.recordData) {
          errorObj.recordData = metadata.recordData;
        }
        
        // Track error statistics
        this.trackError(errorObj);
      } catch (e) {
        errorObj = new Error(error);
      }
      
      reject(errorObj);
    }
    
    // Clean up the job
    this.jobs.delete(jobId);
    
    // Mark worker as available
    this.workersAvailable.push(workerIndex);
    
    // Process the next task in queue
    this.processQueue();
  }

  /**
   * Execute a task in a worker
   * @param {String} taskType - Type of task to execute
   * @param {Object} payload - Data to send to the worker
   * @param {Object} metadata - Additional metadata for context
   * @returns {Promise<any>} - Promise that resolves with the task result
   */
  async executeTask(taskType, payload, metadata = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    return new Promise((resolve, reject) => {
      const jobId = ++this.currentJobId;
      
      // Create a timeout for the task
      const timer = setTimeout(() => {
        if (this.jobs.has(jobId)) {
          const { reject } = this.jobs.get(jobId);
          reject(new Error(`Task '${taskType}' timeout after ${TASK_TIMEOUT}ms`));
          this.jobs.delete(jobId);
          
          logger.warn({ jobId, taskType }, 'Task timeout');
        }
      }, TASK_TIMEOUT);
      
      // Store the job with metadata
      this.jobs.set(jobId, { resolve, reject, timer, taskType, metadata });
      
      // Add to queue
      this.queue.push({ jobId, taskType, payload });
      
      // Try to process immediately
      this.processQueue();
    });
  }

  /**
   * Process tasks in the queue if workers are available
   */
  processQueue() {
    if (this.queue.length === 0 || this.workersAvailable.length === 0) {
      return;
    }
    
    const workerIndex = this.workersAvailable.shift();
    const task = this.queue.shift();
    
    const { jobId, taskType, payload } = task;
    
    try {
      this.workers[workerIndex].postMessage({
        jobId,
        type: taskType,
        data: payload
      });
    } catch (error) {
      // If posting to worker fails, reject the job and mark worker as available
      if (this.jobs.has(jobId)) {
        const { reject, timer } = this.jobs.get(jobId);
        if (timer) clearTimeout(timer);
        reject(new Error(`Failed to send task to worker: ${error.message}`));
        this.jobs.delete(jobId);
      }
      
      this.workersAvailable.push(workerIndex);
      
      // Process next item in queue
      this.processQueue();
    }
  }

  /**
   * Make an API call using a worker
   * @param {Object} options - API call options
   * @param {String} options.url - API endpoint URL
   * @param {Object} options.data - Request payload
   * @param {Object} options.headers - Request headers
   * @param {String} options.method - HTTP method
   * @returns {Promise<Object>} - API response
   */
  async makeApiCall(options) {
    return this.executeTask('api_call', options);
  }

  /**
   * Process record data in a worker
   * @param {Object} record - Record to process
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} - Processed result
   */
  async processRecord(record, options) {
    return this.executeTask('process_record', { record, options }, { recordData: record });
  }

  /**
   * Batch process multiple records in parallel across workers
   * @param {Array} records - Records to process
   * @param {Object} options - Processing options
   * @returns {Promise<Array>} - Array of results
   */
  async batchProcess(records, options) {
    // Create chunks of records to be processed in parallel
    const results = await Promise.allSettled(
      records.map(record => this.processRecord(record, options))
    );
    
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return { 
          success: true, 
          data: result.value,
          record: records[index]
        };
      } else {
        return { 
          success: false, 
          error: result.reason,
          record: records[index],
          userActionRequired: result.reason?.userActionRequired || false
        };
      }
    });
  }

  /**
   * Get the error statistics
   * @returns {Object} Error statistics
   */
  getErrorStats() {
    return {
      counts: this.errorCounts,
      userActionErrors: this.userActionErrors.slice(0, 10) // Return 10 most recent user action errors
    };
  }

  /**
   * Get user action errors that require intervention
   * @param {number} limit - Maximum number of errors to return
   * @returns {Array} - List of user action errors
   */
  getUserActionErrors(limit = 100) {
    return this.userActionErrors.slice(0, limit);
  }

  /**
   * Clear user action errors after they've been handled
   * @param {Array} errorIds - IDs of errors to clear (if empty, clear all)
   */
  clearUserActionErrors(errorIds = []) {
    if (errorIds.length === 0) {
      this.userActionErrors = [];
    } else {
      this.userActionErrors = this.userActionErrors.filter(error => 
        !errorIds.includes(error.id));
    }
  }

  /**
   * Shut down the worker pool
   */
  async shutdown() {
    logger.info('Shutting down worker pool');
    
    // Cancel all pending tasks
    for (const [jobId, { reject, timer }] of this.jobs.entries()) {
      if (timer) clearTimeout(timer);
      reject(new Error('Worker pool shutting down'));
    }
    
    // Clear all internal state
    this.jobs.clear();
    this.queue = [];
    this.workersAvailable = [];
    
    // Terminate all workers
    const terminationPromises = this.workers.map(worker => {
      return worker.terminate();
    });
    
    // Wait for all workers to terminate
    await Promise.all(terminationPromises);
    
    this.workers = [];
    this.initialized = false;
    
    logger.info('Worker pool shut down');
  }
}

// Export singleton instance
const workerPool = new WorkerPool();
export default workerPool;
export { ERROR_CATEGORIES }; 