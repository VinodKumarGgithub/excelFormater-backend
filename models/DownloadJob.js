import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const DownloadJob = sequelize.define('DownloadJob', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
    allowNull: false
  },
  sessionId: {
    type: DataTypes.STRING(50),
    allowNull: false,
    references: {
      model: 'sessions',
      key: 'sessionId'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  prefix: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  targetdbURI: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  fileSize: {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: 0,
    comment: 'File size in bytes'
  },
  downloadPath: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    validate: {
      isArray: function(value) {
        if (value !== null && !Array.isArray(value)) {
          throw new Error('downloadPath must be an array');
        }
      }
    }
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'),
    allowNull: false,
    defaultValue: 'PENDING',
    validate: {
      isIn: [['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']]
    }
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'download_jobs',
  indexes: [
    {
      fields: ['sessionId']
    },
    {
      fields: ['status']
    },
    {
      fields: ['createdAt']
    },
    {
      fields: ['prefix']
    }
  ]
});

export default DownloadJob;
