const jwt = require('jsonwebtoken');
const { getDB } = require('../models/database');

const JWT_SECRET = process.env.JWT_SECRET || 'changeme_secret_32chars_minimum!!';

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function resellerAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'reseller' && decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    
    // Check reseller is still active
    if (decoded.role === 'reseller') {
      const db = getDB();
      const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(decoded.id);
      if (!reseller || !reseller.is_active) {
        return res.status(403).json({ success: false, message: 'Account disabled' });
      }
      req.reseller = reseller;
    }
    
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { adminAuth, resellerAuth, generateToken };
