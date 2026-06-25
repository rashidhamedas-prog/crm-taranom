const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');
const XLSX = require('xlsx');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null; // all
  return req.user.id;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id WHERE c.user_id=? ORDER BY c.created_at DESC').all(scope);
  }
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { biz, owner, city, phone, insta, type, status, note } = req.body;
  if (!biz) return res.status(400).json({ error: 'نام کسب‌وکار الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO customers (user_id,biz,owner,city,phone,insta,type,status,note) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, biz, owner || '', city || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '');
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(result.lastInsertRowid);
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { biz, owner, city, phone, insta, type, status, note } = req.body;
  db.prepare('UPDATE customers SET biz=?,owner=?,city=?,phone=?,insta=?,type=?,status=?,note=? WHERE id=?')
    .run(biz, owner || '', city || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'customer', req.params.id, `حذف مشتری ${row.biz}`);
  res.json({ ok: true });
});

router.get('/export/excel', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'نام کسب‌وکار': r.biz, 'نام صاحب': r.owner, 'شهر': r.city,
    'موبایل': r.phone, 'اینستاگرام': r.insta, 'نوع': r.type, 'وضعیت': r.status,
    'یادداشت': r.note
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
