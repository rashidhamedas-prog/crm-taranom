const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Get all users
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username,role,phone,active,last_login,created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// Create user (salesperson or admin)
router.post('/users', auth, adminOnly, (req, res) => {
  const { name, username, password, phone, role = 'salesperson' } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name,username,password,phone,role) VALUES (?,?,?,?,?)')
    .run(name, username, hash, phone || '', role);
  audit(req.user.id, 'create', 'user', result.lastInsertRowid, `ساخت کاربر ${name}`);
  res.json({ id: result.lastInsertRowid, name, username, phone: phone || '', role });
});

// Update user
router.put('/users/:id', auth, adminOnly, (req, res) => {
  const { name, password, active, role, phone } = req.body;
  const db = getDB();
  if (password) {
    db.prepare('UPDATE users SET name=?,active=?,role=?,phone=?,password=? WHERE id=?')
      .run(name, active, role, phone || '', bcrypt.hashSync(password, 10), req.params.id);
  } else {
    db.prepare('UPDATE users SET name=?,active=?,role=?,phone=? WHERE id=?')
      .run(name, active, role, phone || '', req.params.id);
  }
  audit(req.user.id, 'update', 'user', req.params.id, `ویرایش کاربر ${name}`);
  res.json({ ok: true });
});

// Delete (deactivate) user
router.delete('/users/:id', auth, adminOnly, (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'نمی‌توانید خودتان را حذف کنید' });
  const db = getDB();
  const u = db.prepare('SELECT name FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'user', req.params.id, `غیرفعال‌سازی کاربر ${u ? u.name : ''}`);
  res.json({ ok: true });
});

// Admin dashboard - per-salesperson stats
router.get('/dashboard', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare("SELECT id,name,username FROM users WHERE active=1").all();
  const stats = users.map(u => {
    const custCount = db.prepare('SELECT COUNT(*) as c FROM customers WHERE user_id=?').get(u.id).c;
    const totalSales = db.prepare('SELECT COALESCE(SUM(total),0) as s FROM orders WHERE user_id=?').get(u.id).s;
    const totalDebt = db.prepare('SELECT COALESCE(SUM(total-paid),0) as d FROM orders WHERE user_id=?').get(u.id).d;
    const openFup = db.prepare("SELECT COUNT(*) as c FROM followups WHERE user_id=? AND status='open'").get(u.id).c;
    return { ...u, custCount, totalSales, totalDebt, openFup };
  });
  res.json(stats);
});

// Aggregate overview across ALL users
router.get('/stats/overview', auth, adminOnly, (req, res) => {
  const db = getDB();
  const totalCustomers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(total),0) s FROM orders').get().s;
  const totalPaid = db.prepare('SELECT COALESCE(SUM(paid),0) s FROM orders').get().s;
  const totalDebt = db.prepare('SELECT COALESCE(SUM(total-paid),0) s FROM orders').get().s;
  const totalInvoices = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  const totalProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  const openFollowups = db.prepare("SELECT COUNT(*) c FROM followups WHERE status='open'").get().c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<=stock_alert').get().c;
  res.json({ totalCustomers, totalOrders, totalRevenue, totalPaid, totalDebt, totalInvoices, totalProducts, openFollowups, lowStock });
});

// Data for a specific salesperson (admin)
router.get('/user-data/:userId', auth, adminOnly, (req, res) => {
  const db = getDB();
  const uid = req.params.userId;
  const customers = db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC').all(uid);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(uid);
  const followups = db.prepare('SELECT * FROM followups WHERE user_id=? ORDER BY created_at DESC').all(uid);
  res.json({ customers, orders, followups });
});

// Paginated audit log with filters
router.get('/audit', auth, adminOnly, (req, res) => {
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page || '1'));
  const limit = Math.min(200, parseInt(req.query.limit || '50'));
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  if (req.query.user_id) { where.push('a.user_id=?'); params.push(req.query.user_id); }
  if (req.query.entity) { where.push('a.entity=?'); params.push(req.query.entity); }
  if (req.query.from) { where.push('a.created_at>=?'); params.push(parseInt(req.query.from)); }
  if (req.query.to) { where.push('a.created_at<=?'); params.push(parseInt(req.query.to)); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log a ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT a.*, u.name as user_name FROM audit_log a LEFT JOIN users u ON a.user_id=u.id ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ rows, total, page, limit });
});

module.exports = router;
