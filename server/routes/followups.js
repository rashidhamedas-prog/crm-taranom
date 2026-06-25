const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');
const { todayJalali, nowHHMM } = require('../jalali');
const XLSX = require('xlsx');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz,u.name as salesperson FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id ORDER BY f.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.user_id=? ORDER BY f.created_at DESC').all(scope);
  }
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { cust_id, date, type, subject, note, action, next_date, status, priority } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  // date defaults to today's Jalali; time is always auto-captured server-side.
  const finalDate = date && String(date).trim() ? date : todayJalali();
  const time = nowHHMM();
  const result = db.prepare(
    'INSERT INTO followups (user_id,cust_id,date,time,type,subject,note,action,next_date,status,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cust_id, finalDate, time, type || '📱 تلفن', subject || '', note || '', action || '', next_date || '', status || 'open', priority || 'mid');
  const row = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.id=?').get(result.lastInsertRowid);
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM followups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, date, type, subject, note, action, next_date, status, priority } = req.body;
  // admin may override date manually; keep existing time.
  const finalDate = date && String(date).trim() ? date : (row.date || todayJalali());
  db.prepare('UPDATE followups SET cust_id=?,date=?,type=?,subject=?,note=?,action=?,next_date=?,status=?,priority=? WHERE id=?')
    .run(cust_id, finalDate, type || '📱 تلفن', subject || '', note || '', action || '', next_date || '', status || 'open', priority || 'mid', req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM followups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM followups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/export/excel', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id ORDER BY f.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.user_id=? ORDER BY f.created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'مشتری': r.cust_biz, 'تاریخ': r.date, 'ساعت': r.time, 'نوع تماس': r.type,
    'موضوع': r.subject, 'نتیجه': r.note, 'اقدام بعدی': r.action,
    'تاریخ پیگیری': r.next_date, 'وضعیت': r.status, 'اولویت': r.priority
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'پیگیری‌ها');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=followups.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
