import { User } from '../models/index.js';
import bcrypt from 'bcryptjs';

/**
 * Create a new user
 * @param {Object} userData - User data
 * @param {string} userData.username - Username
 * @param {string} userData.password - Plain text password
 * @param {string} userData.email - Email address
 * @param {string} userData.role - User role (ADMIN or USER)
 * @returns {Promise<Object>} Created user (without password)
 */
export async function createUser(userData) {
    try {
      const { username, password, email, role = 'USER' } = userData;
      
      // Hash password
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      const user = await User.create({
        username,
        password: hashedPassword,
        email,
        role: role.toUpperCase()
      });
      
      // Return user without password
      const { password: _, ...userWithoutPassword } = user.toJSON();
      return userWithoutPassword;
    } catch (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }
  }

/**
 * Find user by username
 * @param {string} username - Username to search for
 * @returns {Promise<Object|null>} User object or null
 */
export async function findByUsername(username) {
    try {
      const user = await User.findOne({
        where: { username },
        attributes: { exclude: ['password'] }
      });
      return user;
    } catch (error) {
      throw new Error(`Failed to find user by username: ${error.message}`);
    }
  }

/**
 * Find user by ID
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} User object or null
 */
export async function findById(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: { exclude: ['password'] }
      });
      return user;
    } catch (error) {
      throw new Error(`Failed to find user by ID: ${error.message}`);
    }
  }

/**
 * Authenticate user with username and password
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<Object|null>} User object or null if authentication fails
 */
export async function authenticate(username, password) {
    try {
      const user = await User.findOne({
        where: { username, isActive: true }
      });
      
      if (!user) {
        return null;
      }
      
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return null;
      }
      
      // Return user without password
      const { password: _, ...userWithoutPassword } = user.toJSON();
      return userWithoutPassword;
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

/**
 * Update user information
 * @param {string} userId - User ID
 * @param {Object} updateData - Data to update
 * @returns {Promise<Object>} Updated user (without password)
 */
export async function updateUser(userId, updateData) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      // Hash password if it's being updated
      if (updateData.password) {
        const saltRounds = 12;
        updateData.password = await bcrypt.hash(updateData.password, saltRounds);
      }
      
      await user.update(updateData);
      
      // Return user without password
      const { password: _, ...userWithoutPassword } = user.toJSON();
      return userWithoutPassword;
    } catch (error) {
      throw new Error(`Failed to update user: ${error.message}`);
    }
  }

/**
 * Deactivate user account
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} Success status
 */
export async function deactivateUser(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      await user.update({ isActive: false });
      return true;
    } catch (error) {
      throw new Error(`Failed to deactivate user: ${error.message}`);
    }
  }

/**
 * Get all users (admin only)
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of users to return
 * @param {number} options.offset - Number of users to skip
 * @returns {Promise<Object>} Users list and pagination info
 */
export async function getAllUsers(options = {}) {
    try {
      const { limit = 50, offset = 0 } = options;
      
      const { count, rows } = await User.findAndCountAll({
        attributes: { exclude: ['password'] },
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['createdAt', 'DESC']]
      });
      
      return {
        users: rows,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(count / limit)
        }
      };
    } catch (error) {
      throw new Error(`Failed to get users: ${error.message}`);
    }
  }


// Default export for backward compatibility
export default {
  createUser,
  findByUsername,
  findById,
  authenticate,
  updateUser,
  deactivateUser,
  getAllUsers
};
