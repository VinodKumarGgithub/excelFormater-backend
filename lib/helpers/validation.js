/**
 * Validation helper functions
 */

/**
 * Validate job data structure and content
 * @param {Array} records - Records to validate
 * @throws {Error} If records are invalid
 */
export function validateJobData(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Invalid or empty records array');
  }
  
  // Enhanced validation with detailed reporting
  const validationResults = {
    valid: true,
    missingFields: [],
    invalidTypes: [],
    details: []
  };
  
  // Validate each record for required fields
  records.forEach((record, index) => {
    const recordValidation = { index, issues: [] };
    
    // Check required fields (customize as needed)
    if (!record.memberId) {
      recordValidation.issues.push('Missing memberId');
      validationResults.missingFields.push('memberId');
    }
    
    if (!record.requestId) {
      recordValidation.issues.push('Missing requestId');
      validationResults.missingFields.push('requestId');
    }
    
    // Add more validations as needed
    
    if (recordValidation.issues.length > 0) {
      validationResults.valid = false;
      validationResults.details.push(recordValidation);
    }
  });
  
  // If validation failed, throw error with details
  if (!validationResults.valid) {
    const validationError = new Error('Job data validation failed');
    validationError.validationResults = validationResults;
    throw validationError;
  }
}

/**
 * Validate API URL
 * @param {string} apiUrl - API URL to validate
 * @throws {Error} If URL is invalid
 */
export function validateApiUrl(apiUrl) {
  if (!apiUrl) {
    throw new Error('Missing API URL');
  }
  
  try {
    new URL(apiUrl);
  } catch (err) {
    throw new Error(`Invalid API URL: ${apiUrl}`);
  }
}

/**
 * Validate session configuration
 * @param {Object} config - Session configuration
 * @throws {Error} If config is invalid
 */
export function validateConfig(config) {
  if (!config) {
    throw new Error('Missing session configuration');
  }
  
  if (!config.apiUrl) {
    throw new Error('Missing apiUrl in configuration');
  }
  
  if (!config.auth) {
    throw new Error('Missing auth in configuration');
  }
} 