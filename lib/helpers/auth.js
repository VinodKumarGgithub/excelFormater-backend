/**
 * Authentication helper functions
 */

/**
 * Create Basic Authentication headers from credentials
 * @param {Object} auth - Authentication credentials
 * @param {string} auth.userId - User ID
 * @param {string} auth.apiKey - API key
 * @returns {Object} - Headers object with Authorization and X-User-Id
 */
export function createAuthHeaders(auth) {
  return {
    Authorization: `Basic ${Buffer.from(`${auth.userId}:${auth.apiKey}`).toString('base64')}`,
    'X-User-Id': auth.userId,
  };
}

/**
 * Validate job data for required authentication fields
 * @param {Object} auth - Authentication object
 * @throws {Error} If authentication fields are missing
 */
export function validateAuth(auth) {
  if (!auth) {
    throw new Error('Missing auth object');
  }
  
  if (!auth.userId) {
    throw new Error('Missing auth.userId');
  }
  
  if (!auth.apiKey) {
    throw new Error('Missing auth.apiKey');
  }
} 