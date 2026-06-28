const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const ALLOWED_KEYS = [
  'telegram_bot_token', 'telegram_chat_id',
  'sms_provider', 'sms_api_key', 'sms_from',
  'company_name', 'company_phone', 'company_address',
  'api_v1_enabled', 'api_rate_limit', 'webhook_secret'
];

// GET all settings (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

// PUT upsert key-value pairs (admin only)
router.put('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (!ALLOWED_KEYS.includes(k)) continue;
      stmt.run(k, v == null ? '' : String(v));
    }
  });
  tx(Object.entries(req.body || {}));
  audit(req.user.id, 'update', 'settings', null, 'بروزرسانی تنظیمات');
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

module.exports = router;
