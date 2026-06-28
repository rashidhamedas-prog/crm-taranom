const router = require('express').Router();
const crypto = require('crypto');
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  return 'trn_' + crypto.randomBytes(24).toString('hex');
}

// List all API keys (admin)
router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(
    'SELECT k.id,k.name,k.key_prefix,k.scopes,k.active,k.last_used,k.created_at,u.name as owner FROM api_keys k LEFT JOIN users u ON k.user_id=u.id ORDER BY k.created_at DESC'
  ).all();
  res.json(rows);
});

// Usage log (admin)
router.get('/usage', auth, adminOnly, (req, res) => {
  const db = getDB();
  const limit = Math.min(200, parseInt(req.query.limit || '100'));
  const rows = db.prepare(
    'SELECT l.*,k.name as key_name FROM api_usage_log l LEFT JOIN api_keys k ON l.api_key_id=k.id ORDER BY l.created_at DESC LIMIT ?'
  ).all(limit);
  res.json(rows);
});

// Create API key (admin)
router.post('/', auth, adminOnly, (req, res) => {
  const { name, scopes = 'read' } = req.body;
  if (!name) return res.status(400).json({ error: 'نام الزامی است' });
  const key = generateKey();
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO api_keys (user_id,name,key_hash,key_prefix,scopes) VALUES (?,?,?,?,?)'
  ).run(req.user.id, name, hashKey(key), key.substring(0, 12), scopes);
  audit(req.user.id, 'create', 'api_key', result.lastInsertRowid, `ساخت کلید API: ${name}`);
  // Return full key only once
  res.json({ id: result.lastInsertRowid, name, key, key_prefix: key.substring(0, 12), scopes, active: 1 });
});

// Update API key (toggle active, rename)
router.put('/:id', auth, adminOnly, (req, res) => {
  const { name, scopes, active } = req.body;
  const db = getDB();
  db.prepare('UPDATE api_keys SET name=?,scopes=?,active=? WHERE id=?')
    .run(name, scopes, active ? 1 : 0, req.params.id);
  audit(req.user.id, 'update', 'api_key', req.params.id, `ویرایش کلید API`);
  res.json({ ok: true });
});

// Delete API key (admin)
router.delete('/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM api_keys WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'api_key', req.params.id, `حذف کلید API`);
  res.json({ ok: true });
});

// Webhook CRUD
router.get('/webhooks', auth, adminOnly, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all());
});

router.post('/webhooks', auth, adminOnly, (req, res) => {
  const { name, url, events = 'customer.created', secret = '' } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'نام و آدرس الزامی است' });
  const db = getDB();
  const r = db.prepare('INSERT INTO webhooks (user_id,name,url,events,secret) VALUES (?,?,?,?,?)')
    .run(req.user.id, name, url, events, secret);
  res.json({ id: r.lastInsertRowid, name, url, events, secret, active: 1 });
});

router.put('/webhooks/:id', auth, adminOnly, (req, res) => {
  const { name, url, events, secret, active } = req.body;
  getDB().prepare('UPDATE webhooks SET name=?,url=?,events=?,secret=?,active=? WHERE id=?')
    .run(name, url, events, secret || '', active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/webhooks/:id', auth, adminOnly, (req, res) => {
  getDB().prepare('DELETE FROM webhooks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, hashKey };
