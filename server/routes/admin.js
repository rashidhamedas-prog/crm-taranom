const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Get all users (include commission fields)
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username,role,phone,active,last_login,commission_cash,commission_cheque,created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// Create user (salesperson or admin)
router.post('/users', auth, adminOnly, (req, res) => {
  const { name, username, password, phone, role = 'salesperson', commission_cash = 0, commission_cheque = 0 } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name,username,password,phone,role,commission_cash,commission_cheque) VALUES (?,?,?,?,?,?,?)')
    .run(name, username, hash, phone || '', role, parseFloat(commission_cash) || 0, parseFloat(commission_cheque) || 0);
  audit(req.user.id, 'create', 'user', result.lastInsertRowid, `ساخت کاربر ${name}`);
  res.json({ id: result.lastInsertRowid, name, username, phone: phone || '', role, commission_cash: parseFloat(commission_cash) || 0, commission_cheque: parseFloat(commission_cheque) || 0 });
});

// Update user
router.put('/users/:id', auth, adminOnly, (req, res) => {
  const { name, password, active, role, phone, commission_cash = 0, commission_cheque = 0 } = req.body;
  const db = getDB();
  if (password) {
    db.prepare('UPDATE users SET name=?,active=?,role=?,phone=?,password=?,commission_cash=?,commission_cheque=? WHERE id=?')
      .run(name, active, role, phone || '', bcrypt.hashSync(password, 10), parseFloat(commission_cash) || 0, parseFloat(commission_cheque) || 0, req.params.id);
  } else {
    db.prepare('UPDATE users SET name=?,active=?,role=?,phone=?,commission_cash=?,commission_cheque=? WHERE id=?')
      .run(name, active, role, phone || '', parseFloat(commission_cash) || 0, parseFloat(commission_cheque) || 0, req.params.id);
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

// Admin dashboard - per-salesperson stats (using final invoices for revenue)
router.get('/dashboard', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare("SELECT id,name,username FROM users WHERE active=1").all();
  const stats = users.map(u => {
    const custCount = db.prepare('SELECT COUNT(*) as c FROM customers WHERE user_id=?').get(u.id).c;
    const totalSales = db.prepare("SELECT COALESCE(SUM(final),0) as s FROM invoices WHERE user_id=? AND type='final'").get(u.id).s;
    const totalDebt = 0; // no orders module anymore; debt tracked via invoices if needed
    const openFup = db.prepare("SELECT COUNT(*) as c FROM followups WHERE user_id=? AND status='open'").get(u.id).c;
    return { ...u, custCount, totalSales, totalDebt, openFup };
  });
  res.json(stats);
});

// Aggregate overview across ALL users (revenue from final invoices only)
router.get('/stats/overview', auth, adminOnly, (req, res) => {
  const db = getDB();
  const totalCustomers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
  const totalInvoices = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final'").get().c;
  const totalProforma = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='proforma'").get().c;
  const totalProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  const openFollowups = db.prepare("SELECT COUNT(*) c FROM followups WHERE status='open'").get().c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<=stock_alert').get().c;
  res.json({ totalCustomers, totalRevenue, totalInvoices, totalProforma, totalProducts, openFollowups, lowStock,
             // legacy fields kept for compatibility
             totalOrders: 0, totalPaid: 0, totalDebt: 0 });
});

// Data for a specific salesperson (admin)
router.get('/user-data/:userId', auth, adminOnly, (req, res) => {
  const db = getDB();
  const uid = req.params.userId;
  const customers = db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC').all(uid);
  const followups = db.prepare('SELECT * FROM followups WHERE user_id=? ORDER BY created_at DESC').all(uid);
  res.json({ customers, followups });
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
