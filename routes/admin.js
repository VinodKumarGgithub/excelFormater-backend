import express from 'express';
import { authenticateJWT } from './sessions.js';
import { 
  addAllowedIP, 
  getAllowedIPs, 
  updateAllowedIP, 
  deleteAllowedIP,
  deactivateAllowedIP 
} from '../services/ipService.js';
import ipPkg from 'ip';

const router = express.Router();

// Protect all admin routes
router.use(authenticateJWT);

// Middleware to check for admin role
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'ADMIN') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Access denied: Admins only.' });
  }
};

// Apply isAdmin middleware to all routes in this router
router.use(isAdmin);

// POST /api/admin/allowed-ips - Add an IP address to the allowed list
router.post('/allowed-ips', async (req, res) => {
  const { ip, deviceId, description, expiresAt } = req.body;

  if (!ip) {
    return res.status(400).json({ success: false, message: 'IP address is required.' });
  }

  // Validate IP address using the 'ip' package
  if (!ipPkg.isV4Format(ip) && !ipPkg.isV6Format(ip)) {
    return res.status(400).json({ success: false, message: 'Invalid IP address format.' });
  }

  try {
    const allowedIP = await addAllowedIP({
      ip,
      deviceId,
      description,
      addedBy: req.user.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : null
    });

    res.json({ 
      success: true, 
      message: `IP address ${ip} added to allowed list.`,
      data: {
        id: allowedIP.id,
        ip: allowedIP.ip,
        deviceId: allowedIP.deviceId,
        description: allowedIP.description,
        expiresAt: allowedIP.expiresAt
      }
    });
  } catch (err) {
    console.error('Error adding allowed IP:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to add allowed IP.' });
  }
});

// GET /api/admin/allowed-ips - Get all allowed IP addresses
router.get('/allowed-ips', async (req, res) => {
  try {
    const { includeExpired = false, includeInactive = false } = req.query;
    
    const allowedIPs = await getAllowedIPs({
      includeExpired: includeExpired === 'true',
      includeInactive: includeInactive === 'true'
    });

    // Format response to match frontend expectations
    const ipList = allowedIPs.map(ip => ({
      id: ip.id,
      ip: ip.ip,
      deviceId: ip.deviceId,
      description: ip.description,
      isActive: ip.isActive,
      expiresAt: ip.expiresAt,
      createdAt: ip.createdAt,
      addedBy: ip.addedByUser ? {
        userId: ip.addedByUser.userId,
        username: ip.addedByUser.username,
        email: ip.addedByUser.email
      } : null
    }));

    res.json({ 
      success: true, 
      count: ipList.length, 
      ipList 
    });
  } catch (err) {
    console.error('Error retrieving allowed IP list:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to retrieve allowed IP list.' });
  }
});

// PUT /api/admin/allowed-ips/:id - Update an allowed IP address
router.put('/allowed-ips/:id', async (req, res) => {
  const { id } = req.params;
  const { ip, deviceId, description, expiresAt, isActive } = req.body;

  try {
    const updateData = {};
    
    if (ip !== undefined) updateData.ip = ip;
    if (deviceId !== undefined) updateData.deviceId = deviceId;
    if (description !== undefined) updateData.description = description;
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedIP = await updateAllowedIP(id, updateData);

    res.json({ 
      success: true, 
      message: 'IP address updated successfully.',
      data: {
        id: updatedIP.id,
        ip: updatedIP.ip,
        deviceId: updatedIP.deviceId,
        description: updatedIP.description,
        isActive: updatedIP.isActive,
        expiresAt: updatedIP.expiresAt
      }
    });
  } catch (err) {
    console.error('Error updating allowed IP:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to update allowed IP.' });
  }
});

// DELETE /api/admin/allowed-ips/:id - Delete an allowed IP address
router.delete('/allowed-ips/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await deleteAllowedIP(id);
    res.json({ success: true, message: 'IP address deleted successfully.' });
  } catch (err) {
    console.error('Error deleting allowed IP:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to delete allowed IP.' });
  }
});

// PATCH /api/admin/allowed-ips/:id/deactivate - Deactivate an allowed IP address
router.patch('/allowed-ips/:id/deactivate', async (req, res) => {
  const { id } = req.params;

  try {
    await deactivateAllowedIP(id);
    res.json({ success: true, message: 'IP address deactivated successfully.' });
  } catch (err) {
    console.error('Error deactivating allowed IP:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to deactivate allowed IP.' });
  }
});

export default router; 