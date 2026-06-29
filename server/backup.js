const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = '/home/taranom-admin/backups';
const BACKUP_FILE = path.join(BACKUP_DIR, 'crm-latest.tar.gz');

async function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    execSync(
      `tar -czf "${BACKUP_FILE}" --exclude="./node_modules" --exclude="./.git" --exclude="./backup" -C "${APP_ROOT}" .`,
      { timeout: 120000 }
    );

    const sizeMB = (fs.statSync(BACKUP_FILE).size / 1024 / 1024).toFixed(2);
    console.log(`✅ پشتیبان ایجاد شد: ${sizeMB} MB → ${BACKUP_FILE}`);
    return { ok: true, local: BACKUP_FILE, sizeMB };
  } catch (e) {
    console.error('backup error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { runBackup, BACKUP_FILE };
