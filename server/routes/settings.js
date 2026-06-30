const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');

const ALLOWED_KEYS = [
  'telegram_bot_token', 'telegram_chat_id',
  'sms_provider', 'sms_api_key', 'sms_from',
  'niksms_api_key', 'smsir_api_key', 'smsir_line',
  'company_name', 'company_phone', 'company_address',
  'kimia_address', 'welcome_sms_text',
  'api_v1_enabled', 'api_rate_limit', 'webhook_secret',
  'backup_smtp_user', 'backup_smtp_pass', 'backup_email'
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

const DEFAULT_WELCOME_SMS = `سلام 🌸 به خانواده پوشاک ترنم خوش‌آمدید!

برای اطلاع از جدیدترین محصولات و تخفیف‌های ویژه، ما را دنبال کنید:

📱 روبیکا: rubika.ir/toliditaranom_omde
✈️ تلگرام: t.me/toliditaranom
💬 بله: bale.ai/toliditaranom
{address}
پوشاک ترنم 🌿`;

// Test SMS — sends the welcome SMS template to the given phone number
router.post('/test-sms', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from','welcome_sms_text','kimia_address')").all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  const to = (req.body.phone || '').trim();
  if (!to) return res.status(400).json({ error: 'شماره موبایل الزامی است' });
  const addrLine = settings.kimia_address ? `\n🏢 آدرس دفتر: ${settings.kimia_address}` : '';
  const text = (settings.welcome_sms_text || DEFAULT_WELCOME_SMS).replace('{address}', addrLine);
  const result = await sendSMS(settings, to, text);
  res.json(result);
});

module.exports = router;
