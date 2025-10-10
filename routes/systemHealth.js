import express from 'express';
import si from 'systeminformation';
import { authenticateJWT } from './sessions.js';
import { getDatabaseHealth } from '../config/database.js';
import redis from '../lib/redis.js';

const router = express.Router();

// Protect all routes with JWT authentication
router.use(authenticateJWT);

// GET /api/system-health
router.get('/system-health', async (req, res) => {
    try {
      const [cpuData, memData, fsData, dbHealth, redisInfo] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        getDatabaseHealth(),
        redis.info('memory')
      ]);
  
      // console.log('CPU Data:', cpuData?.currentLoad.toFixed(2)); // Log to debug
  
      const cpu = Math.round(cpuData?.currentLoad.toFixed(2))
  
      const memory = Math.round((memData.active / memData.total) * 100);
  
      const disk = Math.round((fsData[0].used / fsData[0].size) * 100) || 0;

      // Parse Redis memory info
      const redisMemory = redisInfo.match(/used_memory_human:([^\r\n]+)/)?.[1] || 'Unknown';
      const redisConnected = redis.status === 'ready';
  
      res.json({
        success: true,
        message: 'System health retrieved successfully',
        data: { 
          cpu, 
          memory, 
          disk,
          database: {
            status: dbHealth.status,
            connection: dbHealth.connection,
            pool: dbHealth.pool || null
          },
          redis: {
            connected: redisConnected,
            memory: redisMemory,
            status: redis.status
          }
        }
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve system health',
        error: err.message
      });
    }
  });
  

export default router; 