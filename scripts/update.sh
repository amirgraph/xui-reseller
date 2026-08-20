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

c '1;96' "▸ نصب/به‌روزرسانیِ مانیتورینگِ سرور…"
# سرورهایی که خودشان پنل را اجرا می‌کنند (نصبِ کامل، نه node) دیتابیسِ
# reseller.db محلی دارند و ردیفِ خودشان در جدولِ servers را می‌توان از رویِ
# XUI_URL (که همیشه http://127.0.0.1:PORT است) پیدا کرد — دیگر نیازی نیست
# ادمین جدا از پنل اسکریپتِ مانیتورینگ را دانلود/SCP/SSH کند؛ خودِ update.sh
# هر بار خودش را تازه می‌کند. (سرورهای نودِ ریموت هنوز باید یک‌بار دستی نصب
# شوند — چون Node/DB روی آن‌ها اصلاً اجرا نمی‌شود.)
XUI_URL_LOCAL="$(grep -E '^XUI_URL=' "$APP/.env" 2>/dev/null | cut -d= -f2-)"
SUB_BASE_LOCAL="$(grep -E '^SUB_BASE_URL=' "$APP/.env" 2>/dev/null | cut -d= -f2-)"
PANEL_BASE_LOCAL="${SUB_BASE_LOCAL%/sub*}"
if [ -n "$XUI_URL_LOCAL" ] && [ -n "$PANEL_BASE_LOCAL" ] && [ -f "$APP/data/reseller.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  ROW="$(sqlite3 -separator '|' "$APP/data/reseller.db" "SELECT id, scan_token FROM servers WHERE xui_url='$XUI_URL_LOCAL' LIMIT 1;" 2>/dev/null || true)"
  SID="${ROW%%|*}"; STOK="${ROW#*|}"
  if [ -n "$SID" ] && [ -n "$STOK" ]; then
    BIN=/usr/local/bin/amirpanel-status.sh
    cat > "$BIN" <<REPORTER
#!/usr/bin/env bash
set -uo pipefail
SERVER_ID=$SID
TOKEN='$STOK'
APPLY_URL='${PANEL_BASE_LOCAL}/sub/apply-status'

read -r _ u1 n1 s1 i1 w1 _ < /proc/stat
sleep 1
read -r _ u2 n2 s2 i2 w2 _ < /proc/stat
IDLE1=\$((i1+w1)); IDLE2=\$((i2+w2))
TOTAL1=\$((u1+n1+s1+i1+w1)); TOTAL2=\$((u2+n2+s2+i2+w2))
DT=\$((TOTAL2-TOTAL1)); DI=\$((IDLE2-IDLE1))
CPU=0
[ "\$DT" -gt 0 ] && CPU=\$(awk -v dt="\$DT" -v di="\$DI" 'BEGIN{printf "%.1f", (dt-di)*100/dt}')

MEMTOTAL_KB=\$(awk '/^MemTotal:/{print \$2}' /proc/meminfo)
MEMAVAIL_KB=\$(awk '/^MemAvailable:/{print \$2}' /proc/meminfo)
MEMTOTAL_MB=\$(( MEMTOTAL_KB/1024 ))
MEMUSED_MB=\$(( (MEMTOTAL_KB-MEMAVAIL_KB)/1024 ))

UPTIME_SEC=\$(awk '{print int(\$1)}' /proc/uptime)

XRAY_UP=false
systemctl is-active --quiet x-ui 2>/dev/null && XRAY_UP=true

curl -s --max-time 10 -X POST "\$APPLY_URL" -H 'Content-Type: application/json' \\
  -d "{\\"server_id\\":\$SERVER_ID,\\"token\\":\\"\$TOKEN\\",\\"cpu_pct\\":\$CPU,\\"mem_used_mb\\":\$MEMUSED_MB,\\"mem_total_mb\\":\$MEMTOTAL_MB,\\"xray_active\\":\$XRAY_UP,\\"uptime_sec\\":\$UPTIME_SEC}" >/dev/null 2>&1
REPORTER
    chmod +x "$BIN"
    ( crontab -l 2>/dev/null | grep -v amirpanel-status.sh; echo "* * * * * $BIN" ) | crontab -
    "$BIN" >/dev/null 2>&1 || true
    ok "مانیتورینگِ سرور نصب/تازه شد (سرور #$SID)."
  else
    c '0;90' "  (این سرور هنوز در جدولِ سرورها ثبت نشده — بعدِ ثبت، آپدیتِ بعدی خودکار نصبش می‌کند.)"
  fi
else
  c '0;90' "  (این ماشین دیتابیسِ محلی ندارد — احتمالاً نودِ ریموت است؛ مانیتورینگش را از پنل → سرورها دانلود و دستی نصب کن.)"
fi

ok "به‌روزرسانی کامل شد → نسخهٔ $NEWVER"
c '0;90' "  اگر بنرِ آپدیت هنوز هست، صفحهٔ ادمین را رفرش کن (کشِ نسخه هر ۱ ساعت تازه می‌شود)."
