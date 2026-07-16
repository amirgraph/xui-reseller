#!/usr/bin/env bash
# ماژول ۵۰: اسکنر IP تمیزِ Cloudflare + provision خودکار کاربران روی نهان + cronها
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
die(){ echo "  ✗ $*" >&2; exit 1; }
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
    -e "s|__XHTTP_PATH__|$XHTTP_PATH|g" \
    -e "s|__MAIN_DOMAIN__|$MAIN_DOMAIN|g" \
    -e "s|__NSUB1__|$NSUB1|g" -e "s|__NSUB2__|$NSUB2|g" -e "s|__NSUB3__|$NSUB3|g" \
    "$f"
done

# ⚠️ اگر placeholderی جا بماند، اسکنر بی‌صدا هیچ IP تمیزی پیدا نمی‌کند و
#    NAHAN_ADDRS خالی می‌ماند → sub.js روی دامنه fallback می‌کند → کلِ ترافیکِ
#    VPN مستقیم روی دامنه می‌رود و دامنه می‌سوزد. (__XHTTP_PATH__ دقیقاً همین
#    را کرد: scanner.py آدرسِ `https://sub.example.ir__XHTTP_PATH__` می‌زد و
#    هر ۴۸۰ IP کدِ 000 می‌دادند.) پس اجازه نمی‌دهیم بی‌صدا رد شود:
for f in "$SC/scanner.py" "$SC/updater.py" /opt/provision-nahan.py; do
  left="$(grep -oE '__[A-Z0-9_]+__' "$f" | sort -u | tr '\n' ' ')" || true
  [ -z "$left" ] || die "placeholder jaygozin nashode dar $f: $left"
done
# شناسهٔ اینباند نهان در provision
sed -i "s|INBOUNDS = {[0-9]*:|INBOUNDS = {$NAHAN_ID:|" /opt/provision-nahan.py 2>/dev/null || true
ok "Script haye scanner/provision mostaghar shod (inbounde Nahan id=$NAHAN_ID)."

# ── cronها ──
# ⚠️ روی سرورِ تازه crontab خالی است: `crontab -l` کد ۱ می‌دهد و `grep -v` هم با
#    صفر خط کد ۱ → pipefail+set -e زیرشل را *قبل از echoها* می‌کشد، پس یک
#    crontabِ خالی نصب می‌شد و ماژول می‌مرد. هر دو `|| true` لازم‌اند.
( { crontab -l 2>/dev/null || true; } | grep -vE "provision-nahan|v2pn-cleanip" || true
  echo "*/10 * * * * /usr/bin/python3 /opt/provision-nahan.py >> /var/log/provision-nahan.log 2>&1"
  echo "17 */6 * * * /usr/bin/python3 $SC/scanner.py && /usr/bin/python3 $SC/updater.py >> /var/log/v2pn-cleanip.log 2>&1"
) | crontab -
ok "cron ha tanzim shod (provision har 10 daghighe, scanner har 6 saat)."

# ── اجرای اولیهٔ اسکنر (پرکردن NAHAN_ADDRS) ──
echo "  Ejraye avaliyeye scannere IP tamiz (momken ast kami tul bekeshad)..."
python3 "$SC/scanner.py" >/dev/null 2>&1 && python3 "$SC/updater.py" >/dev/null 2>&1 && ok "IP haye tamiz yafte va dar sub set shod." || \
  echo "  ! Scanner bare aval kamel nashod — cron badan dobare ejra mikonad."
