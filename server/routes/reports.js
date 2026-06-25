const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Summary for a Jalali date range (string comparison works because dates are
// zero-padded "1403/04/01"). from/to are optional.
router.get('/summary', auth, adminOnly, (req, res) => {
  const db = getDB();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const where = [];
  const params = [];
  if (from) { where.push("date>=?"); params.push(from); }
  if (to) { where.push("date<=?"); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const ordAgg = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(total),0) revenue, COALESCE(SUM(paid),0) paid, COALESCE(SUM(total-paid),0) debt FROM orders ${whereSql}`
  ).get(...params);
  // distinct customers that placed an order in range
  const custCount = db.prepare(
    `SELECT COUNT(DISTINCT cust_id) c FROM orders ${whereSql}`
  ).get(...params).c;

  res.json({
    from, to,
    orders: ordAgg.c,
    revenue: ordAgg.revenue,
    paid: ordAgg.paid,
    debt: ordAgg.debt,
    customers: custCount
  });
});

// Revenue grouped by Jalali month (first 7 chars of "1403/04/01" => "1403/04")
router.get('/monthly', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT substr(date,1,7) as ym, COUNT(*) orders, COALESCE(SUM(total),0) revenue, COALESCE(SUM(total-paid),0) debt
    FROM orders
    WHERE date IS NOT NULL AND date<>'' AND length(date)>=7
    GROUP BY ym
    ORDER BY ym ASC
  `).all();
  res.json(rows);
});

// Per-salesperson breakdown
router.get('/salesperson', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare("SELECT id,name,username FROM users WHERE active=1 ORDER BY name").all();
  const data = users.map(u => {
    const orders = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total),0) revenue, COALESCE(SUM(total-paid),0) debt FROM orders WHERE user_id=?').get(u.id);
    const customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE user_id=?').get(u.id).c;
    const openFollowups = db.prepare("SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'").get(u.id).c;
    const invoices = db.prepare('SELECT COUNT(*) c FROM invoices WHERE user_id=?').get(u.id).c;
    return {
      id: u.id, name: u.name, username: u.username,
      orders: orders.c, revenue: orders.revenue, debt: orders.debt,
      customers, openFollowups, invoices
    };
  });
  res.json(data);
});

// Top 10 customers by total order value
router.get('/top-customers', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.city, c.owner,
           COUNT(o.id) orders, COALESCE(SUM(o.total),0) total, COALESCE(SUM(o.total-o.paid),0) debt
    FROM customers c
    JOIN orders o ON o.cust_id=c.id
    GROUP BY c.id
    ORDER BY total DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// All outstanding debts (total > paid)
router.get('/debt', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT o.id, o.date, o.total, o.paid, (o.total-o.paid) debt, o.status,
           c.biz as cust_biz, c.phone as cust_phone, u.name as salesperson
    FROM orders o
    LEFT JOIN customers c ON o.cust_id=c.id
    LEFT JOIN users u ON o.user_id=u.id
    WHERE o.total > o.paid
    ORDER BY debt DESC
  `).all();
  const totalDebt = rows.reduce((a, r) => a + r.debt, 0);
  res.json({ rows, totalDebt });
});

module.exports = router;
