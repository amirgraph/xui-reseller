#!/usr/bin/env bash
# ماژول ۵۰: اسکنر IP تمیزِ Cloudflare + provision خودکار کاربران روی نهان + cronها
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
SC=/root/v2pn-cleanip; mkdir -p "$SC"

# ── استقرار اسکریپت‌ها + جایگزینی placeholderها ──
cp "$HERE/infra/scanner/scanner.py" "$HERE/infra/scanner/updater.py" "$SC/"
cp "$HERE/infra/scanner/provision-nahan.py" /opt/provision-nahan.py

# شناسهٔ اینباند نهان (پویا از DB — چون در نصبِ تازه ID فرق دارد)
NAHAN_ID=$(sqlite3 /etc/x-ui/x-ui.db "SELECT id FROM inbounds WHERE tag='nahan-xhttp' LIMIT 1;" 2>/dev/null || echo 1)

for f in "$SC/scanner.py" "$SC/updater.py" /opt/provision-nahan.py; do
  sed -i \
    -e "s|__XUI_API_KEY__|${XUI_API_KEY:-}|g" \
    -e "s|__XUI_PATH__|$XUI_PATH|g" \
    -e "s|__MAIN_DOMAIN__|$MAIN_DOMAIN|g" \
    -e "s|__NSUB1__|$NSUB1|g" -e "s|__NSUB2__|$NSUB2|g" -e "s|__NSUB3__|$NSUB3|g" \
    "$f"
done
# شناسهٔ اینباند نهان در provision
sed -i "s|INBOUNDS = {[0-9]*:|INBOUNDS = {$NAHAN_ID:|" /opt/provision-nahan.py 2>/dev/null || true
ok "اسکریپت‌های اسکنر/provision مستقر شد (اینباند نهان id=$NAHAN_ID)."

# ── cronها ──
( crontab -l 2>/dev/null | grep -vE "provision-nahan|v2pn-cleanip"
  echo "*/10 * * * * /usr/bin/python3 /opt/provision-nahan.py >> /var/log/provision-nahan.log 2>&1"
  echo "17 */6 * * * /usr/bin/python3 $SC/scanner.py && /usr/bin/python3 $SC/updater.py >> /var/log/v2pn-cleanip.log 2>&1"
) | crontab -
ok "cronها تنظیم شد (provision هر ۱۰دقیقه، اسکنر هر ۶ساعت)."

# ── اجرای اولیهٔ اسکنر (پرکردن NAHAN_ADDRS) ──
echo "  اجرای اولیهٔ اسکنر IP تمیز (ممکن است کمی طول بکشد)..."
python3 "$SC/scanner.py" >/dev/null 2>&1 && python3 "$SC/updater.py" >/dev/null 2>&1 && ok "IPهای تمیز یافته و در sub ست شد." || \
  echo "  ! اسکنر بار اول کامل نشد — cron بعداً دوباره اجرا می‌کند."
