const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

// All messages relevant to current user (received + broadcast + sent)
router.get('/', auth, (req, res) => {
  const db = getDB();
  const msgs = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m
    LEFT JOIN users f ON m.from_id = f.id
    LEFT JOIN users t ON m.to_id = t.id
    WHERE m.to_id = ? OR m.to_id IS NULL OR m.from_id = ?
    ORDER BY m.created_at DESC
    LIMIT 200
  `).all(req.user.id, req.user.id);
  res.json(msgs.map(m => ({
    ...m,
    direction: m.from_id === req.user.id ? 'sent' : 'received'
  })));
});

// Unread count for current user
router.get('/unread-count', auth, (req, res) => {
  const db = getDB();
  const r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE (to_id=? OR to_id IS NULL) AND from_id<>? AND is_read=0')
    .get(req.user.id, req.user.id);
  res.json({ count: r.c });
});

// Send message
router.post('/', auth, (req, res) => {
  const { to_id, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'متن پیام الزامی است' });
  const db = getDB();
  const result = db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)')
    .run(req.user.id, to_id || null, body.trim());
  const row = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id
    WHERE m.id=?`).get(result.lastInsertRowid);
  res.json({ ...row, direction: 'sent' });
});

// Mark one as read
router.post('/read/:id', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND (to_id=? OR to_id IS NULL)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Mark all (to me / broadcast) as read
router.post('/read-all', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE messages SET is_read=1 WHERE (to_id=? OR to_id IS NULL) AND from_id<>?').run(req.user.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
