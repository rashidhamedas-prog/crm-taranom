const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');
const { getDB } = require('./db');

const APP_ROOT = path.resolve(__dirname, '..');
// Dedicated backup folder outside the app directory so it survives git operations
const BACKUP_DIR = '/home/taranom-admin/backups';
const BACKUP_FILE = path.join(BACKUP_DIR, 'crm-latest.tar.gz');

function getBackupSettings() {
  try {
    const db = getDB();
    const rows = db.prepare(
      "SELECT key,value FROM settings WHERE key IN ('backup_smtp_user','backup_smtp_pass','backup_email')"
    ).all();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    return s;
  } catch { return {}; }
}

async function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Archive the entire app, excluding node_modules, .git, and the backup folder itself
    execSync(
      `tar -czf "${BACKUP_FILE}" --exclude="./node_modules" --exclude="./.git" --exclude="./backup" -C "${APP_ROOT}" .`,
      { timeout: 120000 }
    );

    const sizeMB = (fs.statSync(BACKUP_FILE).size / 1024 / 1024).toFixed(2);
    console.log(`✅ پشتیبان ایجاد شد: ${sizeMB} MB → ${BACKUP_FILE}`);

    const s = getBackupSettings();
    if (!s.backup_smtp_user || !s.backup_smtp_pass) {
      console.log('⚠️ اطلاعات Gmail برای ارسال پشتیبان تنظیم نشده است');
      return { ok: true, local: BACKUP_FILE, email: false };
    }

    const recipient = s.backup_email || s.backup_smtp_user;
    const now = new Date();
    const dateStr = now.toLocaleDateString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit' });

    // Google App Passwords work with or without spaces — strip to be safe
    const appPass = s.backup_smtp_pass.replace(/\s+/g, '');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: s.backup_smtp_user, pass: appPass }
    });

    await transporter.sendMail({
      from: `"CRM ترنم" <${s.backup_smtp_user}>`,
      to: recipient,
      subject: '📦 پشتیبان روزانه CRM ترنم',
      text: `پشتیبان روزانه سیستم CRM ترنم\nتاریخ: ${dateStr}\nحجم فایل: ${sizeMB} MB\n\nفایل پشتیبان به این ایمیل پیوست شده است.\nبرای بازیابی: فایل را از حالت فشرده خارج کنید و محتوا را در سرور قرار دهید.`,
      attachments: [{ filename: 'crm-backup.tar.gz', path: BACKUP_FILE }]
    });

    console.log(`📧 پشتیبان به ${recipient} ارسال شد`);
    return { ok: true, local: BACKUP_FILE, email: recipient, sizeMB };
  } catch (e) {
    console.error('backup error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { runBackup, BACKUP_FILE };
