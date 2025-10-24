import sequelize from '../config/database.js';
import User from './User.js';
import Session from './Session.js';
import AllowedIP from './AllowedIP.js';
import DownloadJob from './DownloadJob.js';

// Define associations
User.hasMany(Session, {
  foreignKey: 'userId',
  as: 'sessions',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE'
});

Session.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE'
});

// AllowedIP associations
User.hasMany(AllowedIP, {
  foreignKey: 'addedBy',
  as: 'allowedIPs',
  onDelete: 'SET NULL',
  onUpdate: 'CASCADE'
});

AllowedIP.belongsTo(User, {
  foreignKey: 'addedBy',
  as: 'addedByUser',
  onDelete: 'SET NULL',
  onUpdate: 'CASCADE'
});

// DownloadJob associations
Session.hasMany(DownloadJob, {
  foreignKey: 'sessionId',
  as: 'downloadJobs',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE'
});

DownloadJob.belongsTo(Session, {
  foreignKey: 'sessionId',
  as: 'session',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE'
});

// Initialize database connection and sync models
export const initializeDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established successfully');
    
    // Sync models (create tables if they don't exist)
    await sequelize.sync({ alter: false }); // Use migrations instead of sync for production
    console.log('✅ Database models synchronized');
    
    return true;
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    return false;
  }
};

export { User, Session, AllowedIP, DownloadJob, sequelize };
export default { User, Session, AllowedIP, DownloadJob, sequelize };
