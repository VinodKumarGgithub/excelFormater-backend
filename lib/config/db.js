import { Sequelize } from 'sequelize';
import { logger } from '../services/loggerService.js';

// Setup database connection using MySQL
const sequelize = new Sequelize(
  process.env.DB_NAME || 'excel_batch_db',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
    dialect: 'mysql',
    logging: (msg) => logger.debug(msg),
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

export default sequelize;
