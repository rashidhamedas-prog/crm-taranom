const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { initDB, getDB } = require('./db');
const { todayJalali, nowHHMM } = require('./jalali');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS = path.join(__dirname, 'public', 'uploads', 'products');
fs.mkdirSync(UPLOADS, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 });
app.use('/api', limiter);

initDB();

app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/followups', require('./routes/followups'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/products', require('./routes/products'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/accounting', require('./routes/accounting'));

// Server time endpoint — returns current Jalali date so clients don't rely on device clock
app.get('/api/system/time', (req, res) => {
  const now = new Date();
  const jalali = todayJalali();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  res.json({ jalali, time: `${hh}:${mm}` });
});

// Serve .well-known/assetlinks.json explicitly (TWA domain verification)
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

// SPA fallback for non-API GET requests
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Daily cron: flag silent customers (no order in 30+ days) ----
// Dates are Jalali strings; we use created_at-based recency where possible and
// fall back to "has any order" heuristics, then create an auto followup once.
function runSilentCustomerCheck() {
  try {
    const db = getDB();
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // 30 days ago (unix)
    const today = todayJalali();
    const time = nowHHMM();
    const customers = db.prepare('SELECT * FROM customers').all();
    let created = 0;
    for (const c of customers) {
      const lastOrder = db.prepare('SELECT created_at FROM orders WHERE cust_id=? ORDER BY created_at DESC LIMIT 1').get(c.id);
      // silent = has had orders before but none in last 30 days
      const isSilent = lastOrder && lastOrder.created_at < cutoff;
      if (!isSilent) continue;
      // avoid duplicates: skip if an open auto followup already exists
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

// Run every day at 08:00 server time
cron.schedule('0 8 * * *', runSilentCustomerCheck);

app.listen(PORT, () => {
  console.log(`CRM ترنم نسخه ۳ روی پورت ${PORT} اجرا شد`);
});
