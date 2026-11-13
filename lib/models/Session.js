import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';
import User from './User.js';

const Session = sequelize.define('Session', {
  sessionId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'),
    defaultValue: 'PENDING'
  },
  sourceFileType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fileSize: {
    type: DataTypes.INTEGER, // in bytes
    defaultValue: 0
  },
  txnCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  successCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  errorCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  apiUrl: {
    type: DataTypes.STRING,
    allowNull: false
  },
  apiMethod: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'POST'
  },
  apiType: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'REST'
  },
  authUsername: {
    type: DataTypes.STRING,
    allowNull: true
  },
  authPassword: {
    type: DataTypes.STRING,
    allowNull: true
  },
  sessionConfig: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {}
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: User,
      key: 'id'
    }
  }
}, {
  timestamps: true,
  tableName: 'sessions'
});

// Define Relationships
User.hasMany(Session, { foreignKey: 'createdBy' });
Session.belongsTo(User, { foreignKey: 'createdBy' });

export default Session;
