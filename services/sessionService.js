import { Session } from '../models/index.js';
import redis from '../lib/redis.js';

/**
 * Create a new session in both database and Redis
 * @param {Object} sessionData - Session data
 * @param {string} sessionData.sessionId - Session ID
 * @param {string} sessionData.userId - User ID
 * @param {string} sessionData.apiUrl - API URL
 * @param {Object} sessionData.auth - Authentication details
 * @param {string} sessionData.method - HTTP method
 * @param {number} sessionData.fileSize - File size in bytes
 * @param {string} sessionData.fileType - File type/extension
 * @returns {Promise<Object>} Created session
 */
export async function createSession(sessionData) {
  try {
    const { sessionId, userId, apiUrl, auth, method, fileSize, fileType, totalTxn } = sessionData;
    
    // Create session in database
    const dbSession = await Session.create({
      sessionId,
      userId,
      apiUrl,
      fileSize: fileSize || 0,
      fileType: fileType || null,
      totalTxn: totalTxn || 0,
      status: 'ACTIVE'
    });
    
    // Store session details in Redis for quick access
    const redisData = {
      apiUrl,
      auth,
      method,
      userId,
      fileSize: fileSize || 0,
      fileType: fileType || null,
      status: 'ACTIVE',
      totalTxn: 0,
      createdAt: new Date().toISOString()
    };
    
    await redis.set(`${sessionId}`, JSON.stringify(redisData));
    
    // Add session to user's session list in Redis
    await redis.lpush(`user:sessions:${userId}`, sessionId);
    
    // Set expiration for Redis data (7 days)
    await redis.expire(`${sessionId}`, 7 * 24 * 60 * 60);
    await redis.expire(`user:sessions:${userId}`, 7 * 24 * 60 * 60);
    
    return dbSession;
  } catch (error) {
    throw new Error(`Failed to create session: ${error.message}`);
  }
}

/**
 * Get session by ID from both database and Redis
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object|null>} Session data
 */
export async function getSessionById(sessionId) {
  try {
    // Try Redis first for quick access
    const redisData = await redis.get(`session:${sessionId}`);
    
    if (redisData) {
      const parsedData = JSON.parse(redisData);
      
      // Get additional data from database
      const { User } = await import('../models/index.js');
      const dbSession = await Session.findByPk(sessionId, {
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['userId', 'username', 'email']
          }
        ]
      });
      
      return {
        ...parsedData,
        ...dbSession?.toJSON(),
        fromRedis: true
      };
    }
    
    // Fallback to database if not in Redis
    const { User } = await import('../models/index.js');
    const dbSession = await Session.findByPk(sessionId, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['userId', 'username', 'email']
        }
      ]
    });
    
    if (dbSession) {
      // Restore to Redis for future quick access
      const redisData = {
        apiUrl: dbSession.apiUrl,
        userId: dbSession.userId,
        fileSize: dbSession.fileSize,
        fileType: dbSession.fileType,
        status: dbSession.status,
        totalTxn: dbSession.totalTxn,
        createdAt: dbSession.createdAt
      };
      
      await redis.set(`session:${sessionId}`, JSON.stringify(redisData));
      await redis.expire(`session:${sessionId}`, 7 * 24 * 60 * 60);
      
      return {
        ...dbSession.toJSON(),
        fromRedis: false
      };
    }
    
    return null;
  } catch (error) {
    throw new Error(`Failed to get session: ${error.message}`);
  }
}

/**
 * Get sessions by user ID
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of sessions to return
 * @param {number} options.offset - Number of sessions to skip
 * @param {string} options.status - Filter by status
 * @returns {Promise<Object>} Sessions and pagination info
 */
export async function getSessionsByUserId(userId, options = {}) {
  try {
    const { limit = 50, offset = 0, status } = options;
    
    const whereClause = { userId };
    if (status) {
      whereClause.status = status;
    }
    
    const { count, rows } = await Session.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: (await import('../models/index.js')).User,
          as: 'user',
          attributes: ['userId', 'username', 'email']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']]
    });
    
    return {
      sessions: rows,
      pagination: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset),
        pages: Math.ceil(count / limit)
      }
    };
  } catch (error) {
    throw new Error(`Failed to get user sessions: ${error.message}`);
  }
}

/**
 * Get all sessions (admin only)
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of sessions to return
 * @param {number} options.offset - Number of sessions to skip
 * @param {string} options.status - Filter by status
 * @returns {Promise<Object>} Sessions and pagination info
 */
export async function getAllSessions(options = {}) {
  try {
    const { limit = 50, offset = 0, status } = options;
    
    const whereClause = {};
    if (status) {
      whereClause.status = status;
    }
    
    const { count, rows } = await Session.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: (await import('../models/index.js')).User,
          as: 'user',
          attributes: ['userId', 'username', 'email']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']]
    });
    
    return {
      sessions: rows,
      pagination: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset),
        pages: Math.ceil(count / limit)
      }
    };
  } catch (error) {
    throw new Error(`Failed to get all sessions: ${error.message}`);
  }
}

/**
 * Update session status
 * @param {string} sessionId - Session ID
 * @param {string} status - New status
 * @param {number} totalTxn - Total transactions processed
 * @returns {Promise<Object>} Updated session
 */
export async function updateSessionStatus(sessionId, status, totalTxn = null) {
  try {
    const updateData = { status };
    
    if (status === 'COMPLETED' || status === 'FAILED') {
      updateData.completedAt = new Date();
    }
    
    if (totalTxn !== null) {
      updateData.totalTxn = totalTxn;
    }
    
    // Update database
    const dbSession = await Session.findByPk(sessionId);
    if (!dbSession) {
      throw new Error('Session not found');
    }
    
    await dbSession.update(updateData);
    
    // Update Redis cache
    const redisData = await redis.get(`session:${sessionId}`);
    if (redisData) {
      const parsedData = JSON.parse(redisData);
      const updatedRedisData = {
        ...parsedData,
        status,
        totalTxn: totalTxn !== null ? totalTxn : parsedData.totalTxn,
        completedAt: updateData.completedAt
      };
      
      await redis.set(`session:${sessionId}`, JSON.stringify(updatedRedisData));
      await redis.expire(`session:${sessionId}`, 7 * 24 * 60 * 60);
    }
    
    return dbSession;
  } catch (error) {
    throw new Error(`Failed to update session status: ${error.message}`);
  }
}

/**
 * Update session data
 * @param {string} sessionId - Session ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} Updated session
 */
export async function updateSession(sessionId, updateData) {
  try {
    const dbSession = await Session.findByPk(sessionId);
    if (!dbSession) {
      throw new Error('Session not found');
    }
    
    await dbSession.update(updateData);
    
    // Update Redis cache
    const redisData = await redis.get(`session:${sessionId}`);
    if (redisData) {
      const parsedData = JSON.parse(redisData);
      const updatedRedisData = {
        ...parsedData,
        ...updateData
      };
      
      await redis.set(`session:${sessionId}`, JSON.stringify(updatedRedisData));
      await redis.expire(`session:${sessionId}`, 7 * 24 * 60 * 60);
    }
    
    return dbSession;
  } catch (error) {
    throw new Error(`Failed to update session: ${error.message}`);
  }
}

/**
 * Delete session from both database and Redis
 * @param {string} sessionId - Session ID
 * @returns {Promise<boolean>} Success status
 */
export async function deleteSession(sessionId) {
  try {
    // Get session to find userId
    const session = await Session.findByPk(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    // Delete from database
    await session.destroy();
    
    // Remove from Redis
    await redis.del(`session:${sessionId}`);
    
    // Remove from user's session list
    await redis.lrem(`user:sessions:${session.userId}`, 0, sessionId);
    
    return true;
  } catch (error) {
    throw new Error(`Failed to delete session: ${error.message}`);
  }
}

/**
 * Get session statistics
 * @param {string} userId - User ID (optional, for user-specific stats)
 * @returns {Promise<Object>} Session statistics
 */
export async function getSessionStats(userId = null) {
  try {
    const whereClause = userId ? { userId } : {};
    
    const { fn, col } = await import('sequelize');
    const stats = await Session.findAll({
      where: whereClause,
      attributes: [
        'status',
        [fn('COUNT', col('sessionId')), 'count'],
        [fn('SUM', col('totalTxn')), 'totalTransactions']
      ],
      group: ['status'],
      raw: true
    });
    
    const totalSessions = await Session.count({ where: whereClause });
    const totalTransactions = await Session.sum('totalTxn', { where: whereClause }) || 0;
    
    return {
      totalSessions,
      totalTransactions,
      byStatus: stats.reduce((acc, stat) => {
        acc[stat.status] = {
          count: parseInt(stat.count),
          totalTransactions: parseInt(stat.totalTransactions) || 0
        };
        return acc;
      }, {})
    };
  } catch (error) {
    throw new Error(`Failed to get session stats: ${error.message}`);
  }
}

/**
 * Clean up expired sessions from Redis (keep database records)
 * @returns {Promise<number>} Number of cleaned up sessions
 */
export async function cleanupExpiredSessions() {
  try {
    // Get all session keys from Redis
    const sessionKeys = await redis.keys('session:*');
    let cleanedCount = 0;
    
    for (const key of sessionKeys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1) {
        // Key exists but has no expiration, set one
        await redis.expire(key, 7 * 24 * 60 * 60);
      } else if (ttl === -2) {
        // Key doesn't exist, remove from user lists
        const sessionId = key.replace('session:', '');
        const userIds = await redis.keys('user:sessions:*');
        
        for (const userKey of userIds) {
          await redis.lrem(userKey, 0, sessionId);
        }
        cleanedCount++;
      }
    }
    
    return cleanedCount;
  } catch (error) {
    throw new Error(`Failed to cleanup expired sessions: ${error.message}`);
  }
}
