#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  Amir Panel — به‌روزرسانیِ امن روی سرور
#  کدِ اپ را از ریپو می‌گیرد و روی /opt/xui-reseller می‌گذارد،
#  بدونِ دست‌زدن به .env / data/ (دیتابیس) / node_modules.
#  اجرا:  sudo bash update.sh        (یا: curl ... | sudo bash)
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
APP="${APP:-/opt/xui-reseller}"
REPO="${REPO:-https://github.com/amirgraph/xui-reseller}"
BRANCH="${BRANCH:-main}"
c(){ printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
die(){ c '1;91' "  ✗ $*"; exit 1; }
ok(){ c '1;92' "  ✓ $*"; }

[ "$(id -u)" = 0 ] || die "با sudo/root اجرا کن."
[ -d "$APP" ] || die "$APP نیست — این سرور نصبِ Amir Panel ندارد."

c '1;96' "▸ گرفتنِ آخرین نسخه از $REPO ($BRANCH)…"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if command -v git >/dev/null 2>&1 && git clone --depth 1 -b "$BRANCH" "$REPO" "$TMP/repo" >/dev/null 2>&1; then
  SRC="$TMP/repo"
else
  # fallback بدونِ git: tarball
  curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar xz -C "$TMP" || die "دانلود نشد (git و curl هر دو ناموفق)."
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'xui-reseller-*' | head -1)"
fi
[ -d "$SRC/app" ] || die "ساختارِ ریپو نامعتبر (app/ نیست)."

NEWVER="$(node -e "console.log(require('$SRC/app/package.json').version)" 2>/dev/null || echo '?')"
OLDVER="$(node -e "console.log(require('$APP/package.json').version)" 2>/dev/null || echo '?')"
c '0;90' "  نسخهٔ فعلی: $OLDVER  →  نسخهٔ جدید: $NEWVER"

# بک‌آپِ .env (محضِ احتیاط)
[ -f "$APP/.env" ] && cp -a "$APP/.env" "$APP/.env.bak.$(date +%Y%m%d-%H%M%S)" && ok "بک‌آپِ .env گرفته شد."

# کپیِ کدِ اپ — .env و data/ و node_modules در ریپو نیستند، پس دست‌نخورده می‌مانند
c '1;96' "▸ اعمالِ فایل‌های جدید…"
cp -a "$SRC/app/." "$APP/"
# اسکریپت‌های infra (اسکنر/آپدیتر) هم به‌روز شوند اگر روی سرور مستقر شده‌اند
if [ -d /root/v2pn-cleanip ] && [ -f "$SRC/infra/scanner/updater.py" ]; then
  cp -a "$SRC/infra/scanner/scanner.py" "$SRC/infra/scanner/updater.py" /root/v2pn-cleanip/ 2>/dev/null || true
  ok "اسکریپت‌های اسکنر به‌روز شد."
fi

c '1;96' "▸ نصبِ وابستگی‌ها…"
cd "$APP"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --production >/dev/null 2>&1 || die "npm install شکست خورد."

c '1;96' "▸ ری‌استارتِ سرویس‌ها…"
pm2 restart xui-reseller --update-env >/dev/null 2>&1 || die "pm2 restart (پنل) شکست خورد."
pm2 restart xui-bot --update-env >/dev/null 2>&1 || true
pm2 save >/dev/null 2>&1 || true

ok "به‌روزرسانی کامل شد → نسخهٔ $NEWVER"
c '0;90' "  اگر بنرِ آپدیت هنوز هست، صفحهٔ ادمین را رفرش کن (کشِ نسخه هر ۱ ساعت تازه می‌شود)."
