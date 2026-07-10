#!/usr/bin/env bash
# ماژول ۰۰: نصب پیش‌نیازها
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ok(){ echo "  ✓ $*"; }

echo "  به‌روزرسانی و نصب بسته‌های پایه..."
apt-get update -qq
apt-get install -y -qq curl wget tar unzip jq sqlite3 openssl ca-certificates \
  iproute2 iptables wireguard-tools cron python3 python3-venv >/dev/null
ok "ابزارهای پایه نصب شد."

# ── Node.js 20 (اگر نبود) ──
if ! command -v node >/dev/null || [ "$(node -v | cut -c2 | tr -d v)" -lt 2 ] 2>/dev/null; then
  echo "  نصب Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

# ── nginx با ماژول stream ──
if ! command -v nginx >/dev/null; then
  echo "  نصب nginx..."
  apt-get install -y -qq nginx-full >/dev/null
fi
# اطمینان از وجود ماژول stream
if ! nginx -V 2>&1 | grep -q stream && ! ls /etc/nginx/modules-enabled/ 2>/dev/null | grep -qi stream; then
  apt-get install -y -qq libnginx-mod-stream >/dev/null 2>&1 || true
fi
systemctl stop nginx 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default
ok "nginx $(nginx -v 2>&1 | grep -o '[0-9.]*' | head -1)"

# ── pm2 برای مدیریت اپ node ──
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null 2>&1
ok "pm2 آماده."

ok "همهٔ پیش‌نیازها نصب شد."
