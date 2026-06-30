const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { initDB, getDB } = require('./db');
const { todayJalali, nowHHMM } = require('./jalali');
const { sendSMS } = require('./sms');
const { hashKey } = require('./routes/api_keys');
const { runBackup } = require('./backup');

const app = express();
app.set('trust proxy', 1); // trust Nginx reverse proxy
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS = path.join(__dirname, 'public', 'uploads', 'products');
fs.mkdirSync(UPLOADS, { recursive: true });

// Security headers (helmet if available, manual fallback)
let helmet = null;
try { helmet = require('helmet'); } catch {}
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false, // SPA manages its own CSP
    crossOriginEmbedderPolicy: false,
  }));
} else {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore it; rely on CSP
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });
}

// CORS — restrict to same origin in production, allow dev origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Same-origin requests (origin===undefined) and explicitly listed origins are allowed
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Static assets (includes /uploads/products/* and /logo.png if present)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('assetlinks.json')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// General API rate limit (generous — protects against runaway loops)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// Strict rate limit on authentication endpoints — brute-force protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تعداد تلاش‌های ورود بیش از حد مجاز است. ۱۵ دقیقه دیگر تلاش کنید.' },
  skipSuccessfulRequests: true,
});
app.use('/api/auth/login', authLimiter);

initDB();

app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/followups', require('./routes/followups'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/products', require('./routes/products'));
app.use('/api/admin', require('./routes/admin'));

// Manual backup endpoint — registered before admin router catch-all
const { auth, adminOnly } = require('./middleware/auth');
app.post('/api/admin/backup-now', auth, adminOnly, async (req, res) => {
  const result = await runBackup();
  res.json(result);
});

// Download latest backup file directly to admin's browser
app.get('/api/admin/backup-download', auth, adminOnly, async (req, res) => {
  const { BACKUP_FILE } = require('./backup');
  if (!fs.existsSync(BACKUP_FILE)) {
    // No backup yet — create one first
    const result = await runBackup();
    if (!result.ok) return res.status(500).json({ error: result.error });
  }
  res.download(BACKUP_FILE, 'crm-latest.tar.gz');
});
app.use('/api/messages', require('./routes/messages'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/api-keys', require('./routes/api_keys').router);
app.use('/api/v1', require('./routes/api_v1'));

// Server time endpoint — returns Unix timestamp (UTC) for reliable client clock sync
app.get('/api/system/time', (req, res) => {
  res.json({ ts: Date.now() });
});

// Serve .well-known/assetlinks.json explicitly (TWA domain verification)
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

// SPA fallback for non-API GET requests — no-cache so updates are always picked up
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSMSSettings() {
  try {
    const db = getDB();
    const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from')").all();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    return s;
  } catch { return {}; }
}

function logSMS(db, userId, custId, phone, body, status) {
  try {
    db.prepare('INSERT INTO sms_log (user_id,cust_id,phone,body,status) VALUES (?,?,?,?,?)')
      .run(userId || null, custId || null, phone, body, status);
  } catch {}
}

// ── Daily cron: batch SMS for today's follow-ups (no scheduled time) ─────────
async function runFollowupSMSBatch() {
  try {
    const db = getDB();
    const today = todayJalali();
    const settings = getSMSSettings();
    if (!settings.sms_api_key) return;

    // Followups due today with no specific time and SMS not yet sent
    const followups = db.prepare(
      "SELECT f.*,c.biz as cust_biz,c.owner as cust_owner,u.phone as user_phone,u.id as uid FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id WHERE f.next_date=? AND (f.next_time IS NULL OR f.next_time='') AND f.status='open' AND f.sms_sent=0"
    ).all(today);

    // Group by user
    const byUser = {};
    for (const f of followups) {
      if (!f.uid || !f.user_phone) continue;
      if (!byUser[f.uid]) byUser[f.uid] = { phone: f.user_phone, items: [] };
      byUser[f.uid].items.push(f);
    }

    for (const [uid, group] of Object.entries(byUser)) {
      const lines = group.items.map(f => `• ${f.cust_biz || '-'}${f.cust_owner ? ' - ' + f.cust_owner : ''}`).join('\n');
      const text = `پیگیری‌های امروز\n\n${lines}`;
      const result = await sendSMS(settings, group.phone, text);
      const status = result.ok ? 'sent' : 'failed';
      // Mark all as sent regardless of result to avoid spam on retry
      const ids = group.items.map(f => f.id);
      db.prepare(`UPDATE followups SET sms_sent=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      for (const f of group.items) {
        logSMS(db, uid, f.cust_id, group.phone, text, status);
      }
      console.log(`📱 SMS دسته‌ای برای کاربر ${uid}: ${group.items.length} پیگیری → ${status}`);
    }
  } catch (e) {
    console.error('cron followup-sms error:', e.message);
  }
}

// ── Per-minute cron: send SMS 1 hour BEFORE the scheduled follow-up time ──────
async function runTimedFollowupSMS() {
  try {
    const db = getDB();
    const today = todayJalali();
    const now = nowHHMM();
    const settings = getSMSSettings();
    if (!settings.sms_api_key) return;

    // Compute what next_time value we're looking for: 1 hour from now
    const [h, m] = now.split(':').map(Number);
    const targetH = h + 1;
    if (targetH >= 24) return; // skip: reminder would land past midnight
    const targetTime = `${String(targetH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    const followups = db.prepare(
      "SELECT f.*,c.biz as cust_biz,c.owner as cust_owner,u.phone as user_phone,u.id as uid FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id WHERE f.next_date=? AND f.next_time=? AND f.status='open' AND f.sms_sent=0"
    ).all(today, targetTime);

    for (const f of followups) {
      if (!f.uid || !f.user_phone) continue;
      const text = `یادآور پیگیری (۱ ساعت دیگر)\n\n• ${f.cust_biz || '-'}${f.cust_owner ? ' - ' + f.cust_owner : ''}\nساعت پیگیری: ${targetTime}`;
      const result = await sendSMS(settings, f.user_phone, text);
      db.prepare('UPDATE followups SET sms_sent=1 WHERE id=?').run(f.id);
      logSMS(db, f.uid, f.cust_id, f.user_phone, text, result.ok ? 'sent' : 'failed');
      console.log(`📱 SMS ۱ ساعت قبل از پیگیری ${f.id} (ساعت ${targetTime}): ${result.ok ? 'ارسال شد' : 'خطا'}`);
    }
  } catch (e) {
    console.error('cron timed-sms error:', e.message);
  }
}

// ── Daily cron: flag silent customers (no order in 30+ days) ─────────────────
function runSilentCustomerCheck() {
  try {
    const db = getDB();
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const today = todayJalali();
    const time = nowHHMM();
    const customers = db.prepare('SELECT * FROM customers').all();
    let created = 0;
    for (const c of customers) {
      const lastOrder = db.prepare('SELECT created_at FROM orders WHERE cust_id=? ORDER BY created_at DESC LIMIT 1').get(c.id);
      const isSilent = lastOrder && lastOrder.created_at < cutoff;
      if (!isSilent) continue;
      const existing = db.prepare(
        "SELECT id FROM followups WHERE cust_id=? AND status='open' AND subject LIKE '%مشتری خاموش%'"
      ).get(c.id);
      if (existing) continue;
      db.prepare(
        'INSERT INTO followups (user_id,cust_id,date,time,type,subject,note,status,priority) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(c.user_id, c.id, today, time, '🔔 سیستمی', `مشتری خاموش - ${c.biz}`,
            'بیش از ۳۰ روز است سفارشی ثبت نکرده است. لطفاً پیگیری شود.', 'open', 'high');
      created++;
    }
    if (created) console.log(`🔔 ${created} پیگیری خودکار برای مشتریان خاموش ساخته شد`);
  } catch (e) {
    console.error('cron silent-check error:', e.message);
  }
}

// ── Daily cron: active customers with no final invoice in 14 days → 'followup' ──
function runActiveToFollowupCheck() {
  try {
    const db = getDB();
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
    const customers = db.prepare("SELECT * FROM customers WHERE status='active'").all();
    let updated = 0;
    for (const c of customers) {
      const lastInv = db.prepare("SELECT created_at FROM invoices WHERE cust_id=? AND type='final' ORDER BY created_at DESC LIMIT 1").get(c.id);
      if (!lastInv || lastInv.created_at < cutoff) {
        db.prepare("UPDATE customers SET status='followup' WHERE id=?").run(c.id);
        updated++;
      }
    }
    if (updated) console.log(`🔄 ${updated} مشتری فعال بدون خرید ۱۴ روزه به وضعیت پیگیری تغییر یافت`);
  } catch (e) {
    console.error('cron active-to-followup error:', e.message);
  }
}

// Daily at 08:00: batch SMS + silent customer check + active→followup
cron.schedule('0 8 * * *', () => {
  runFollowupSMSBatch();
  runSilentCustomerCheck();
  runActiveToFollowupCheck();
});

// Every minute: timed follow-up SMS
cron.schedule('* * * * *', runTimedFollowupSMS);

// Daily at 00:00: full app backup → local file + Gmail
cron.schedule('0 0 * * *', runBackup);

// Global error handler — never leak stack traces to clients
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('unhandled error:', err.message);
  res.status(err.status || 500).json({ error: 'خطای داخلی سرور' });
});

app.listen(PORT, () => {
  console.log(`CRM ترنم نسخه ۳ روی پورت ${PORT} اجرا شد`);
});
