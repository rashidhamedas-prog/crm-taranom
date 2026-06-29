const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

// List messages for current user
// Admin: all messages (broadcast + direct to any user)
// Non-admin: only direct messages to/from them (no broadcasts to others)
router.get('/', auth, (req, res) => {
  const db = getDB();
  let msgs;
  if (req.user.role === 'admin') {
    msgs = db.prepare(`
      SELECT m.*, f.name as from_name, t.name as to_name
      FROM messages m
      LEFT JOIN users f ON m.from_id = f.id
      LEFT JOIN users t ON m.to_id = t.id
      ORDER BY m.created_at DESC
      LIMIT 300
    `).all();
  } else {
    // Non-admin sees only: messages sent to them directly OR sent by them
    msgs = db.prepare(`
      SELECT m.*, f.name as from_name, t.name as to_name
      FROM messages m
      LEFT JOIN users f ON m.from_id = f.id
      LEFT JOIN users t ON m.to_id = t.id
      WHERE m.to_id = ? OR m.from_id = ?
      ORDER BY m.created_at DESC
      LIMIT 200
    `).all(req.user.id, req.user.id);
  }
  res.json(msgs.map(m => ({
    ...m,
    direction: m.from_id === req.user.id ? 'sent' : 'received'
  })));
});

// Unread count for current user
router.get('/unread-count', auth, (req, res) => {
  const db = getDB();
  let r;
  if (req.user.role === 'admin') {
    // Admin: all unread (direct to them + broadcasts from others)
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE (to_id=? OR to_id IS NULL) AND from_id<>? AND is_read=0')
      .get(req.user.id, req.user.id);
  } else {
    // Non-admin: only direct unread messages
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE to_id=? AND from_id<>? AND is_read=0')
      .get(req.user.id, req.user.id);
  }
  res.json({ count: r.c });
});

// Send message
router.post('/', auth, (req, res) => {
  const { to_id, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'متن پیام الزامی است' });
  // Non-admins can only send to admins (to_id must be an admin or null)
  const db = getDB();
  if (req.user.role !== 'admin' && to_id) {
    const target = db.prepare('SELECT role FROM users WHERE id=?').get(to_id);
    if (!target || target.role !== 'admin') return res.status(403).json({ error: 'فقط می‌توانید به مدیر پیام بفرستید' });
  }
  // Only admin can broadcast (to_id = null)
  const recipient = (req.user.role === 'admin') ? (to_id || null) : (to_id || null);
  if (!to_id && req.user.role !== 'admin') return res.status(403).json({ error: 'ارسال همگانی فقط توسط مدیر' });
  const result = db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)')
    .run(req.user.id, recipient, body.trim());
  const row = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id
    WHERE m.id=?`).get(result.lastInsertRowid);
  res.json({ ...row, direction: 'sent' });
});

// Mark one message as read
router.post('/read/:id', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND (to_id=? OR to_id IS NULL)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Mark all as read (for this user)
router.post('/read-all', auth, (req, res) => {
  const db = getDB();
  if (req.user.role === 'admin') {
    db.prepare('UPDATE messages SET is_read=1 WHERE (to_id=? OR to_id IS NULL) AND from_id<>?').run(req.user.id, req.user.id);
  } else {
    db.prepare('UPDATE messages SET is_read=1 WHERE to_id=? AND from_id<>?').run(req.user.id, req.user.id);
  }
  res.json({ ok: true });
});

// Delete a message (sender or admin can delete)
router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && msg.from_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// List all users for compose recipient (non-admin gets admin list only)
router.get('/users', auth, (req, res) => {
  const db = getDB();
  let users;
  if (req.user.role === 'admin') {
    users = db.prepare('SELECT id,name,role FROM users WHERE active=1 AND id<>? ORDER BY name').all(req.user.id);
  } else {
    users = db.prepare("SELECT id,name,role FROM users WHERE active=1 AND role='admin' ORDER BY name").all();
  }
  res.json(users);
});

module.exports = router;
