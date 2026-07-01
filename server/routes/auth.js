const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB, audit } = require('../db');
const { auth, adminOnly, SECRET } = require('../middleware/auth');

// In-memory failed-login tracker: { username: { count, until } }
const failedLogins = new Map();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

function isLockedOut(username) {
  const rec = failedLogins.get(username);
  if (!rec) return false;
  if (Date.now() < rec.until) return true;
  failedLogins.delete(username);
  return false;
}

function recordFailure(username) {
  const rec = failedLogins.get(username) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.until = Date.now() + LOCKOUT_MS;
  failedLogins.set(username, rec);
}

// Login
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 64);
  const password = (req.body.password || '').slice(0, 128);
  if (!username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });

  if (isLockedOut(username))
    return res.status(429).json({ error: 'حساب به دلیل تلاش‌های مکرر ناموفق قفل شده است. ۱۵ دقیقه دیگر تلاش کنید.' });

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    recordFailure(username);
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }

  failedLogins.delete(username); // reset on success
  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
    SECRET, { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone || '' } });
});

// Get current user
router.get('/me', auth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id,name,username,role,phone,last_login FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

// Change own password
router.post('/change-password', auth, (req, res) => {
  const oldPass = (req.body.oldPass || '').slice(0, 128);
  const newPass = (req.body.newPass || '').slice(0, 128);
  if (!newPass || newPass.length < 6) return res.status(400).json({ error: 'رمز جدید باید حداقل ۶ کاراکتر باشد' });
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPass, user.password))
    return res.status(400).json({ error: 'رمز قدیمی اشتباه است' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), req.user.id);
  res.json({ ok: true });
});

// Admin: reset a user's password
router.post('/reset-password', auth, adminOnly, (req, res) => {
  const user_id = req.body.user_id;
  const new_pass = (req.body.new_pass || '').slice(0, 128);
  if (!user_id || !new_pass || new_pass.length < 6) return res.status(400).json({ error: 'اطلاعات ناقص یا رمز کوتاه‌تر از ۶ کاراکتر' });
  const db = getDB();
  const target = db.prepare('SELECT id,name FROM users WHERE id=?').get(user_id);
  if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_pass, 10), user_id);
  audit(req.user.id, 'reset_password', 'user', user_id, `بازنشانی رمز ${target.name}`);
  res.json({ ok: true });
});

// Admin: list all users with last_login
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username,role,phone,active,last_login,commission_cash,commission_cheque,incentive_locked,created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

module.exports = router;
