/**
 * Record storage service — manages Sequelize MySQL persistence 
 * for user action errors and successful API responses natively.
 */
import { logger } from './loggerService.js';
import ApiLog from '../models/ApiLog.js';

/**
 * Store a user action error (4XX) for later resolution natively in MySQL
 */
export async function storeUserActionError(error, sessionId, jobId, record) {
  try {
    const errorId = `${sessionId}:${jobId}:${Date.now()}`; // kept for backward compatibility references
    const transactionId = record.requestId || record.memberId || jobId;

    await ApiLog.upsert({
      sessionId,
      transactionId,
      status: 0,
      statusCode: error.statusCode,
      errorDetails: JSON.stringify({
        message: error.message,
        validationErrors: error.validationErrors,
        userActionGuidance: error.userActionGuidance,
        permissionInfo: error.permissionInfo
      }),
      requestPayload: JSON.stringify(record),
      attemptNumber: error.attempts || 1
    });

    logger.info({
      sessionId, jobId,
      type: 'USER_ACTION_REQUIRED',
      message: `User action required tracked natively inside DB: ${error.message}`
    });

    return errorId;
  } catch (err) {
    logger.error({ error: err.message, originalError: error.message }, 'Failed to persistently store user action error');
    return null;
  }
}

/**
 * Store a successful API response directly into MySQL
 */
export async function storeSuccessfulApiResponse(response, sessionId, jobId, record) {
  try {
    const responseId = `${sessionId}:${jobId}:${Date.now()}`;
    const transactionId = record.requestId || record.memberId || jobId;

    await ApiLog.upsert({
      sessionId,
      transactionId,
      status: 1,
      statusCode: response.status,
      endpoint: response.url || null,
      responseTime: response.duration || 0,
      requestPayload: JSON.stringify(record),
      responseBody: JSON.stringify(response.data),
      attemptNumber: response.attempts || 1
    });

    return responseId;
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to push successful API response sequentially into DB');
    return null;
  }
}

/**
 * Get all user action errors natively from DB
 */
export async function getUserActionErrors(sessionId) {
  try {
    const errors = await ApiLog.findAll({
      where: { sessionId, status: 0 },
      order: [['createdAt', 'DESC']]
    });

    return errors.map(log => ({
      errorId: log.id,
      sessionId: log.sessionId,
      statusCode: log.statusCode,
      timestamp: log.createdAt,
      message: log.errorDetails ? JSON.parse(log.errorDetails)?.message : 'Unknown Error Check Log',
      validationErrors: log.errorDetails ? JSON.parse(log.errorDetails)?.validationErrors : [],
      userActionGuidance: log.errorDetails ? JSON.parse(log.errorDetails)?.userActionGuidance : '',
      record: log.requestPayload ? JSON.parse(log.requestPayload) : {}
    }));
  } catch (err) {
    logger.error({ error: err.message, sessionId }, 'Failed to extract user action errors natively via Sequelize');
    return [];
  }
}

/**
 * Mark a user action error as resolved via DB
 */
export async function resolveUserActionError(errorId, resolution) {
  try {
    const log = await ApiLog.findByPk(errorId);
    if (!log) return false;

    // Parse existing error details and append resolution
    let existingDetails = {};
    try {
      existingDetails = log.errorDetails ? JSON.parse(log.errorDetails) : {};
    } catch (_) {}

    existingDetails.resolved = true;
    existingDetails.resolution = resolution;
    existingDetails.resolvedAt = new Date().toISOString();

    await log.update({
      errorDetails: JSON.stringify(existingDetails)
    });

    logger.info({
      errorId,
      sessionId: log.sessionId,
      type: 'USER_ACTION_RESOLVED',
      message: `User action error resolved: ${errorId}`
    });

    return true;
  } catch (err) {
    logger.error({ error: err.message, errorId }, 'Failed to resolve user action error in DB');
    return false;
  }
}

/**
 * Get successful API responses natively drawn from DB
 */
export async function getSuccessfulResponses(sessionId) {
  try {
    const successes = await ApiLog.findAll({
      where: { sessionId, status: 1 },
      order: [['createdAt', 'DESC']]
    });

    return successes.map(log => ({
      responseId: log.id,
      sessionId: log.sessionId,
      statusCode: log.statusCode,
      timestamp: log.createdAt,
      durationMs: log.responseTime,
      record: log.requestPayload ? JSON.parse(log.requestPayload) : {},
      data: log.responseBody ? JSON.parse(log.responseBody) : {}
    }));
  } catch (err) {
    logger.error({ error: err.message, sessionId }, 'Failed to grab successful responses correctly through the DB proxy');
    return [];
  }
}
