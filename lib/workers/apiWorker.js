/**
 * API Worker Thread - Handles API requests in a separate thread
 * This worker runs in a separate thread to offload API calls from the main thread
 */
import { parentPort } from 'worker_threads';
import axios from 'axios';

// Configuration
const API_TIMEOUT = 15000; // 15 seconds

// API error categories
const ERROR_CATEGORIES = {
  REQUIRES_USER_ACTION: 'REQUIRES_USER_ACTION', // 4XX errors requiring user input/action
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',       // Temporary issues that may resolve with retry
  SYSTEM_ERROR: 'SYSTEM_ERROR',                 // Server errors or system issues
  NETWORK_ERROR: 'NETWORK_ERROR',               // Network connectivity issues
  AUTH_ERROR: 'AUTH_ERROR',                     // Authentication/authorization issues
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'                // Unclassified errors
};

// Error status codes that require user action
const USER_ACTION_STATUS_CODES = [
  400, // Bad Request - often indicates invalid input
  403, // Forbidden - often indicates permission issues
  404, // Not Found - resource doesn't exist
  409, // Conflict - resource state conflict
  422, // Unprocessable Entity - validation errors
];

// Authentication error codes
const AUTH_ERROR_CODES = [401, 403];

// Configure axios instance with enhanced settings
const api = axios.create({
  timeout: API_TIMEOUT,
  validateStatus: status => status < 500, // Retry only on 500+ errors
  headers: {
    'User-Agent': 'POC-Excel-Formatter/1.0',
    'Content-Type': 'application/json'
  }
});

// Set up axios interceptors for metrics
api.interceptors.request.use(config => {
  config.metadata = { startTime: Date.now() };
  return config;
}, error => {
  return Promise.reject(error);
});

api.interceptors.response.use(response => {
  const duration = Date.now() - response.config.metadata.startTime;
  response.duration = duration;
  return response;
}, error => {
  return Promise.reject(error);
});

/**
 * Categorize API errors to help determine appropriate handling strategy
 * @param {Error} error - The API error
 * @returns {Object} - Categorized error with metadata
 */
function categorizeError(error) {
  let category = ERROR_CATEGORIES.UNKNOWN_ERROR;
  const statusCode = error.response?.status;
  
  // Determine error category
  if (statusCode) {
    if (USER_ACTION_STATUS_CODES.includes(statusCode)) {
      category = ERROR_CATEGORIES.REQUIRES_USER_ACTION;
    } else if (AUTH_ERROR_CODES.includes(statusCode)) {
      category = ERROR_CATEGORIES.AUTH_ERROR;
    } else if (statusCode === 429) {
      category = ERROR_CATEGORIES.TEMPORARY_FAILURE;
    } else if (statusCode >= 500) {
      category = ERROR_CATEGORIES.SYSTEM_ERROR;
    }
  } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
    category = ERROR_CATEGORIES.NETWORK_ERROR;
  } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    category = ERROR_CATEGORIES.NETWORK_ERROR;
  }
  
  // Extract validation errors if available
  let validationErrors = null;
  if (statusCode === 400 || statusCode === 422) {
    validationErrors = error.response?.data?.errors || 
                       error.response?.data?.validationErrors ||
                       error.response?.data?.details;
  }
  
  // For 403 errors, try to extract permission information
  let permissionInfo = null;
  if (statusCode === 403) {
    permissionInfo = error.response?.data?.permission || 
                     error.response?.data?.requiredPermissions ||
                     error.response?.headers?.['required-permission'];
  }
  
  // Extract user action guidance if available
  let userActionGuidance = error.response?.data?.userAction ||
                          error.response?.data?.userGuidance ||
                          error.response?.headers?.['user-action'];
  
  return {
    category,
    statusCode,
    message: error.message,
    userActionRequired: category === ERROR_CATEGORIES.REQUIRES_USER_ACTION,
    canRetry: category === ERROR_CATEGORIES.TEMPORARY_FAILURE || category === ERROR_CATEGORIES.NETWORK_ERROR,
    validationErrors,
    permissionInfo,
    userActionGuidance,
    rawError: {
      data: error.response?.data,
      headers: error.response?.headers,
      status: error.response?.status
    }
  };
}

/**
 * Handle API calls
 * @param {Object} data - API call parameters
 * @returns {Promise<Object>} - API response
 */
async function handleApiCall(data) {
  const { url, method = 'POST', data: payload, headers = {} } = data;
  
  try {
    const requestConfig = {
      url,
      method,
      headers,
      data: payload
    };
    
    // Make the API request
    const response = await api.request(requestConfig);
    
    return {
      status: response.status,
      data: response.data,
      headers: response.headers,
      duration: response.duration,
      success: true
    };
  } catch (error) {
    // Categorize the error for better handling
    const categorizedError = categorizeError(error);
    
    throw {
      ...categorizedError,
      success: false
    };
  }
}

/**
 * Process a single record
 * @param {Object} data - Record processing parameters
 * @returns {Promise<Object>} - Processing result
 */
async function processRecord(data) {
  const { record, options } = data;
  const { apiUrl, headers, retryConfig = {} } = options;
  
  // Default retry configuration
  const maxRetries = retryConfig.maxRetries || 3;
  const getBackoffDelay = retryConfig.getBackoffDelay || 
    ((attempt) => Math.pow(2, attempt) * 1000); // Exponential backoff
  
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      const apiCallStart = Date.now();
      
      // Make the API call
      const response = await api.post(apiUrl, record, { 
        headers,
        // Add timeout that increases with each retry attempt
        timeout: API_TIMEOUT + (attempt * 5000)
      });
      
      const apiCallDuration = Date.now() - apiCallStart;
      
      return {
        status: response.status,
        data: response.data,
        headers: response.headers,
        duration: apiCallDuration,
        attempts: attempt + 1,
        success: true
      };
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt === maxRetries;
      
      // Categorize the error for better handling
      const categorizedError = categorizeError(err);
      const statusCode = categorizedError.statusCode || 0;
      
      // Don't retry errors that require user action
      if (categorizedError.category === ERROR_CATEGORIES.REQUIRES_USER_ACTION) {
        throw {
          ...categorizedError,
          attempts,
          success: false
        };
      }
      
      // Handle specific error types for enhanced retry logic
      let shouldRetry = !isLastAttempt && categorizedError.canRetry;
      let retryDelay = getBackoffDelay(attempt);
      
      // For rate limiting, use the Retry-After header if available
      if (statusCode === 429 && err.response?.headers?.['retry-after']) {
        const retryAfter = parseInt(err.response.headers['retry-after']);
        if (!isNaN(retryAfter)) {
          retryDelay = retryAfter * 1000; // Convert to ms
        } else {
          // If retry-after is a date string
          const retryDate = new Date(err.response.headers['retry-after']);
          if (!isNaN(retryDate.getTime())) {
            retryDelay = Math.max(1000, retryDate.getTime() - Date.now());
          }
        }
      }
      
      if (isLastAttempt || !shouldRetry) {
        throw {
          ...categorizedError,
          attempts,
          success: false
        };
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Export error categories for the main thread to use
parentPort.postMessage({
  type: 'init',
  data: {
    errorCategories: ERROR_CATEGORIES
  }
});

// Set up message handler
parentPort.on('message', async (message) => {
  const { jobId, type, data } = message;
  
  try {
    let result;
    
    // Process different task types
    switch (type) {
      case 'api_call':
        result = await handleApiCall(data);
        break;
      case 'process_record':
        result = await processRecord(data);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send success response back to main thread
    parentPort.postMessage({
      jobId,
      type: 'success',
      data: result
    });
  } catch (error) {
    // Send error response back to main thread
    parentPort.postMessage({
      jobId,
      type: 'error',
      error: typeof error === 'string' ? error : JSON.stringify(error)
    });
  }
});

// Notify that worker is ready
parentPort.postMessage({
  type: 'ready'
}); 