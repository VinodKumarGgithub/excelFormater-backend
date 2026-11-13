import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';
import Session from './Session.js';

const ApiLog = sequelize.define('ApiLog', {
  sessionId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: Session,
      key: 'sessionId'
    }
  },
  transactionId: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Reference ID for the processed record'
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: '1 for success, 0 for failure'
  },
  statusCode: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'HTTP Status Code (e.g., 200, 400, 500)'
  },
  endpoint: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'API endpoint URL accessed'
  },
  requestPayload: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Exact payload sent (JSON stringified)'
  },
  responseBody: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Response body returned from the server'
  },
  errorDetails: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Detailed error message or stack trace'
  },
  responseTime: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Response time in milliseconds'
  },
  attemptNumber: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: 'Current retry/attempt number'
  }
}, {
  timestamps: true,
  tableName: 'api_logs',
  indexes: [
    {
      unique: true,
      fields: ['transactionId', 'status'],
      name: 'unique_txn_status'
    }
  ]
});

// Define Relationships
Session.hasMany(ApiLog, { foreignKey: 'sessionId' });
ApiLog.belongsTo(Session, { foreignKey: 'sessionId' });

export default ApiLog;
