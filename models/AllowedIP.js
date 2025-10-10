import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const AllowedIP = sequelize.define('AllowedIP', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false
  },
  ip: {
    type: DataTypes.STRING(45), // IPv6 can be up to 45 characters
    allowNull: false,
    unique: true,
    validate: {
      notEmpty: true,
      isIP: true // Sequelize built-in IP validation
    }
  },
  deviceId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    validate: {
      len: [0, 100]
    }
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
    validate: {
      len: [0, 255]
    }
  },
  addedBy: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'userId'
    }
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
    validate: {
      isDate: true
    }
  }
}, {
  tableName: 'allowed_ips',
  indexes: [
    {
      unique: true,
      fields: ['ip']
    },
    {
      fields: ['isActive']
    },
    {
      fields: ['expiresAt']
    },
    {
      fields: ['addedBy']
    }
  ],
  hooks: {
    beforeValidate: (allowedIP) => {
      // Normalize IP address (remove leading zeros, etc.)
      if (allowedIP.ip) {
        allowedIP.ip = allowedIP.ip.trim();
      }
    }
  }
});

export default AllowedIP;
