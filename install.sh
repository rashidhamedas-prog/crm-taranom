#!/bin/bash
set -e
echo "========================================="
echo "   CRM ترنم - نصب خودکار نسخه ۳"
echo "========================================="

REPO="https://github.com/rashidhamedas-prog/crm-taranom.git"
APP_DIR="/root/crm-taranom"

# 1. Stop old app if running
echo "[1/6] متوقف کردن نسخه قدیمی..."
pm2 delete crm-taranom 2>/dev/null || true

# 2. Clone / update repo
echo "[2/6] دریافت کد از GitHub..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git fetch origin main && git reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi

# 3. Install Node dependencies
echo "[3/6] نصب وابستگی‌ها..."
cd "$APP_DIR/server"
npm install --production

# 4. Create uploads dir
echo "[4/6] ساخت پوشه‌ها..."
mkdir -p public/uploads/products

# 5. Install & configure PM2
echo "[5/6] راه‌اندازی PM2..."
npm install -g pm2 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true

# 6. Done
echo ""
echo "========================================="
echo "✅ نصب کامل شد!"
echo "   آدرس: http://45.90.98.99:3000"
echo "   یوزر: admin  /  رمز: admin123"
echo "========================================="
pm2 status
