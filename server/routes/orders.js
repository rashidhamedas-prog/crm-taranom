const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

// Deduct stock once, when an order becomes 'done' and references a product.
function maybeDeductStock(db, order) {
  if (order.status === 'done' && order.product_id && !order.stock_deducted && order.qty > 0) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(order.product_id);
    if (prod) {
      const newStock = Math.max(0, prod.stock - order.qty);
      db.prepare('UPDATE products SET stock=? WHERE id=?').run(newStock, prod.id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
        .run(prod.id, order.user_id, -order.qty, `کسر از سفارش #${order.id}`);
      db.prepare('UPDATE orders SET stock_deducted=1 WHERE id=?').run(order.id);
    }
  }
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT o.*,c.biz as cust_biz,u.name as salesperson FROM orders o LEFT JOIN customers c ON o.cust_id=c.id LEFT JOIN users u ON o.user_id=u.id ORDER BY o.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id WHERE o.user_id=? ORDER BY o.created_at DESC').all(scope);
  }
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note } = req.body;
  if (!cust_id || !total) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO orders (user_id,cust_id,product_id,date,type,qty,total,paid,pay,deliver,status,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid);
  maybeDeductStock(db, order);
  const row = db.prepare('SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id WHERE o.id=?').get(result.lastInsertRowid);
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note } = req.body;
  db.prepare('UPDATE orders SET cust_id=?,product_id=?,date=?,type=?,qty=?,total=?,paid=?,pay=?,deliver=?,status=?,note=? WHERE id=?')
    .run(cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '', req.params.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  maybeDeductStock(db, updated);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'order', req.params.id, `حذف سفارش #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
