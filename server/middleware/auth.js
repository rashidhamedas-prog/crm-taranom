const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const SECRET = process.env.JWT_SECRET || 'taranom-crm-secret-2024';

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const payload = jwt.verify(token, SECRET);
    // Verify the account is still active on every request (blocks deactivated users immediately)
    const user = getDB().prepare('SELECT active FROM users WHERE id=?').get(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'حساب کاربری غیرفعال است' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'توکن نامعتبر' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'دسترسی ندارید' });
  next();
}

module.exports = { auth, adminOnly, SECRET };
