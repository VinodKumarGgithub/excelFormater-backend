import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const Session = sequelize.define('Session', {
  sessionId: {
    type: DataTypes.STRING(50),
    primaryKey: true,
    allowNull: false,
    unique: true
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'userId'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  apiUrl: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      isUrl: true,
      notEmpty: true
    }
  },
  fileSize: {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: 0,
    comment: 'File size in bytes'
  },
  fileType: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'File type/extension (e.g., xlsx, csv)'
  },
  totalTxn: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Total number of transactions processed'
  },
  status: {
    type: DataTypes.ENUM('ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED'),
    allowNull: false,
    defaultValue: 'ACTIVE',
    validate: {
      isIn: [['ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED']]
    }
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'sessions',
  indexes: [
    {
      fields: ['userId']
    },
    {
      fields: ['status']
    },
    {
      fields: ['createdAt']
    }
  ]
});

export default Session;
