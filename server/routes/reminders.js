const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = req.user.role === 'admin' ? null : req.user.id;
  let rows;
  if (scope === null) {
    rows = db.prepare(`
      SELECT r.*, u.name as user_name, c.biz as cust_biz
      FROM reminders r
      LEFT JOIN users u ON r.user_id=u.id
      LEFT JOIN customers c ON r.cust_id=c.id
      ORDER BY r.remind_at ASC
    `).all();
  } else {
    rows = db.prepare(`
      SELECT r.*, c.biz as cust_biz
      FROM reminders r
      LEFT JOIN customers c ON r.cust_id=c.id
      WHERE r.user_id=?
      ORDER BY r.remind_at ASC
    `).all(scope);
  }
  res.json(rows);
});

router.get('/due', auth, (req, res) => {
  const db = getDB();
  const today = new Date().toLocaleDateString('fa-IR');
  const rows = db.prepare(`
    SELECT r.*, c.biz as cust_biz
    FROM reminders r
    LEFT JOIN customers c ON r.cust_id=c.id
    WHERE r.user_id=? AND r.done=0 AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `).all(req.user.id, today);
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { cust_id, title, body, remind_at } = req.body;
  if (!title || !remind_at) return res.status(400).json({ error: 'عنوان و تاریخ الزامی است' });
  const db = getDB();
  const result = db.prepare('INSERT INTO reminders (user_id,cust_id,title,body,remind_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, cust_id || null, title, body || '', remind_at);
  res.json({ id: result.lastInsertRowid });
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, title, body, remind_at, done } = req.body;
  db.prepare('UPDATE reminders SET cust_id=?,title=?,body=?,remind_at=?,done=? WHERE id=?')
    .run(cust_id || null, title, body || '', remind_at, done ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/done', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE reminders SET done=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM reminders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
