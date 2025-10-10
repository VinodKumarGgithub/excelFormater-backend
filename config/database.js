import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'excel_processor',
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  dialect: 'mysql',
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  define: {
    timestamps: true,
    underscored: false,
    freezeTableName: true
  }
});

// Test database connection
export const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ MySQL database connection established successfully');
    return true;
  } catch (error) {
    console.error('❌ Unable to connect to MySQL database:', error.message);
    return false;
  }
};

// Get database health status
export const getDatabaseHealth = async () => {
  try {
    await sequelize.authenticate();
    const pool = sequelize.connectionManager.pool;
    return {
      status: 'healthy',
      connection: 'connected',
      pool: {
        used: pool.used,
        waiting: pool.pending,
        size: pool.size
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      connection: 'disconnected',
      error: error.message
    };
  }
};

export default sequelize;
