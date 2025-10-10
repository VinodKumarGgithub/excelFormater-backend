import { AllowedIP, User } from '../models/index.js';
import { Op } from 'sequelize';
import ipPkg from 'ip';

/**
 * Add an IP address to the allowed list
 * @param {Object} ipData - IP data
 * @param {string} ipData.ip - IP address
 * @param {string} ipData.deviceId - Optional device ID
 * @param {string} ipData.description - Optional description
 * @param {string} ipData.addedBy - User ID who added the IP
 * @param {Date} ipData.expiresAt - Optional expiration date
 * @returns {Promise<Object>} Created allowed IP record
 */
export async function addAllowedIP(ipData) {
  try {
    const { ip, deviceId, description, addedBy, expiresAt } = ipData;
    
    // Validate IP address
    if (!ipPkg.isV4Format(ip) && !ipPkg.isV6Format(ip)) {
      throw new Error('Invalid IP address format');
    }
    
    // Check if IP already exists
    const existingIP = await AllowedIP.findOne({
      where: { ip, isActive: true }
    });
    
    if (existingIP) {
      throw new Error('IP address already exists in allowed list');
    }
    
    const allowedIP = await AllowedIP.create({
      ip: ip.trim(),
      deviceId: deviceId || null,
      description: description || null,
      addedBy: addedBy || null,
      expiresAt: expiresAt || null
    });
    
    return allowedIP;
  } catch (error) {
    throw new Error(`Failed to add allowed IP: ${error.message}`);
  }
}

/**
 * Get all allowed IP addresses
 * @param {Object} options - Query options
 * @param {boolean} options.includeExpired - Include expired IPs
 * @param {boolean} options.includeInactive - Include inactive IPs
 * @returns {Promise<Array>} Array of allowed IP records
 */
export async function getAllowedIPs(options = {}) {
  try {
    const { includeExpired = false, includeInactive = false } = options;
    
    const whereClause = {};
    
    if (!includeInactive) {
      whereClause.isActive = true;
    }
    
    if (!includeExpired) {
      whereClause[Op.or] = [
        { expiresAt: null },
        { expiresAt: { [Op.gt]: new Date() } }
      ];
    }
    
    const allowedIPs = await AllowedIP.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'addedByUser',
          attributes: ['userId', 'username', 'email']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    return allowedIPs;
  } catch (error) {
    throw new Error(`Failed to get allowed IPs: ${error.message}`);
  }
}

/**
 * Get allowed IP by ID
 * @param {string} id - Allowed IP ID
 * @returns {Promise<Object|null>} Allowed IP record or null
 */
export async function getAllowedIPById(id) {
  try {
    const allowedIP = await AllowedIP.findByPk(id, {
      include: [
        {
          model: User,
          as: 'addedByUser',
          attributes: ['userId', 'username', 'email']
        }
      ]
    });
    
    return allowedIP;
  } catch (error) {
    throw new Error(`Failed to get allowed IP by ID: ${error.message}`);
  }
}

/**
 * Check if an IP address is allowed
 * @param {string} ip - IP address to check
 * @returns {Promise<boolean>} True if IP is allowed
 */
export async function isIPAllowed(ip) {
  try {
    const allowedIP = await AllowedIP.findOne({
      where: {
        ip: ip.trim(),
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } }
        ]
      }
    });
    
    return !!allowedIP;
  } catch (error) {
    throw new Error(`Failed to check IP allowance: ${error.message}`);
  }
}

/**
 * Update an allowed IP record
 * @param {string} id - Allowed IP ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} Updated allowed IP record
 */
export async function updateAllowedIP(id, updateData) {
  try {
    const allowedIP = await AllowedIP.findByPk(id);
    if (!allowedIP) {
      throw new Error('Allowed IP not found');
    }
    
    // Validate IP if it's being updated
    if (updateData.ip) {
      if (!ipPkg.isV4Format(updateData.ip) && !ipPkg.isV6Format(updateData.ip)) {
        throw new Error('Invalid IP address format');
      }
      
      // Check if new IP already exists (excluding current record)
      const existingIP = await AllowedIP.findOne({
        where: { 
          ip: updateData.ip.trim(), 
          isActive: true,
          id: { [Op.ne]: id }
        }
      });
      
      if (existingIP) {
        throw new Error('IP address already exists in allowed list');
      }
      
      updateData.ip = updateData.ip.trim();
    }
    
    await allowedIP.update(updateData);
    
    return allowedIP;
  } catch (error) {
    throw new Error(`Failed to update allowed IP: ${error.message}`);
  }
}

/**
 * Deactivate an allowed IP record
 * @param {string} id - Allowed IP ID
 * @returns {Promise<boolean>} Success status
 */
export async function deactivateAllowedIP(id) {
  try {
    const allowedIP = await AllowedIP.findByPk(id);
    if (!allowedIP) {
      throw new Error('Allowed IP not found');
    }
    
    await allowedIP.update({ isActive: false });
    return true;
  } catch (error) {
    throw new Error(`Failed to deactivate allowed IP: ${error.message}`);
  }
}

/**
 * Delete an allowed IP record
 * @param {string} id - Allowed IP ID
 * @returns {Promise<boolean>} Success status
 */
export async function deleteAllowedIP(id) {
  try {
    const allowedIP = await AllowedIP.findByPk(id);
    if (!allowedIP) {
      throw new Error('Allowed IP not found');
    }
    
    await allowedIP.destroy();
    return true;
  } catch (error) {
    throw new Error(`Failed to delete allowed IP: ${error.message}`);
  }
}

/**
 * Clean up expired IP addresses
 * @returns {Promise<number>} Number of expired IPs cleaned up
 */
export async function cleanupExpiredIPs() {
  try {
    const expiredCount = await AllowedIP.update(
      { isActive: false },
      {
        where: {
          expiresAt: { [Op.lt]: new Date() },
          isActive: true
        }
      }
    );
    
    return expiredCount[0]; // Sequelize returns [affectedCount, affectedRows]
  } catch (error) {
    throw new Error(`Failed to cleanup expired IPs: ${error.message}`);
  }
}

