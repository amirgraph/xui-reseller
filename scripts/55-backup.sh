#!/usr/bin/env bash
# ماژول ۵۵: بک‌آپِ خودکارِ شبانه به کانالِ تلگرام + ابزارِ بازیابی (فقط امیر پنل)
# x-ui.db + reseller.db + سورسِ پنل/بات + amirpanel.conf → تارِ فشرده → کانالِ تلگرام.
set -euo pipefail
ENV_FILE="$1"
set -a; . "$ENV_FILE"; set +a
ok(){ echo "  ✓ $*"; }

# کانفیگِ بک‌آپ (توکنِ همان باتِ پنل؛ کانال را ادمین ست می‌کند)
cat > /etc/amirpanel-backup.env <<ENV
KASH_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
BACKUP_CHANNEL=${BACKUP_CHANNEL:-}
ENV
chmod 600 /etc/amirpanel-backup.env

cat > /usr/local/bin/amirpanel-backup.sh <<'SCR'
#!/usr/bin/env bash
set -uo pipefail
source /etc/amirpanel-backup.env 2>/dev/null || true
STAMP=$(date +%Y%m%d-%H%M%S); OUT=/root/amirpanel-backups; mkdir -p "$OUT"
TMP=$(mktemp -d)
# مهم: SQLite در حالتِ WAL است؛ cp ساده دیتابیسِ ناقص/corrupt می‌دهد.
# با «.backup» اسنپ‌شاتِ اتمیک و سالم می‌گیریم (fallback به cp اگر sqlite3 نبود).
sqlbackup(){ sqlite3 "$1" ".backup '$2'" 2>/dev/null || cp "$1" "$2" 2>/dev/null || true; }
sqlbackup /etc/x-ui/x-ui.db          "$TMP/x-ui.db"
sqlbackup /opt/xui-reseller/data/reseller.db "$TMP/reseller.db"
mkdir -p "$TMP/src"; rsync -a --exclude node_modules --exclude data --exclude backups --exclude '*.bak*' /opt/xui-reseller/ "$TMP/src/" 2>/dev/null || true
cp /etc/nginx/sites-available/amirpanel.conf "$TMP/" 2>/dev/null || true
A="$OUT/amirpanel-$STAMP.tar.gz"; tar -czf "$A" -C "$TMP" . 2>/dev/null; rm -rf "$TMP"
ls -1t "$OUT"/amirpanel-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
S=$(du -h "$A" | cut -f1)
if [ -n "${KASH_BOT_TOKEN:-}" ] && [ -n "${BACKUP_CHANNEL:-}" ]; then
  curl -s --max-time 180 -F chat_id="$BACKUP_CHANNEL" -F caption="Amir Panel backup $STAMP ($S)" -F document=@"$A" "https://api.telegram.org/bot$KASH_BOT_TOKEN/sendDocument" >/dev/null 2>&1 && echo "SENT $S" || echo "SEND_FAIL"
else echo "LOCAL_ONLY $S"; fi
SCR
chmod +x /usr/local/bin/amirpanel-backup.sh

cat > /usr/local/bin/amirpanel-restore.sh <<'SCR'
#!/usr/bin/env bash
# بازیابیِ دیتای امیر پنل. پیش‌فرض فقط دیتا (reseller.db + سورس) را برمی‌گرداند و
# .env و x-ui.db را دست نمی‌زند (مخصوصِ هر سرورند — بازنویسی‌شان سرورِ مقصد را می‌شکند).
# برای بازیابیِ کاملِ همان‌سرور (DR): amirpanel-restore.sh <file> --with-xui
set -uo pipefail
SRC="${1:-}"; MODE="${2:-}"
[ -f "$SRC" ] || { echo "usage: amirpanel-restore.sh <backup.tar.gz> [--with-xui]"; exit 1; }
SAFE=/root/amirpanel-backups/pre-restore-$(date +%s); mkdir -p "$SAFE"
cp /etc/x-ui/x-ui.db "$SAFE/" 2>/dev/null || true; cp /opt/xui-reseller/data/reseller.db "$SAFE/" 2>/dev/null || true
T=$(mktemp -d); tar -xzf "$SRC" -C "$T" || { echo "extract failed"; exit 1; }
# reseller.db را با تستِ سلامت برگردان (اگر corrupt بود، بازنگردان)
if [ -f "$T/reseller.db" ] && sqlite3 "$T/reseller.db" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$'; then
  mkdir -p /opt/xui-reseller/data; rm -f /opt/xui-reseller/data/reseller.db-wal /opt/xui-reseller/data/reseller.db-shm
  cp "$T/reseller.db" /opt/xui-reseller/data/reseller.db; echo "  reseller.db restored"
else echo "  ! reseller.db backup kharab/nist — nadadeh shod (data feli mahfuz)"; fi
# سورس (کد) — بدونِ .env
[ -d "$T/src" ] && { cp -a "$T/src/src/." /opt/xui-reseller/src/ 2>/dev/null || true; cp -a "$T/src/public/." /opt/xui-reseller/public/ 2>/dev/null || true; echo "  source restored (.env dast nakhord)"; }
# x-ui.db فقط با --with-xui (هم‌سرور)؛ در مهاجرت به سرورِ دیگر نباید بیاید
if [ "$MODE" = "--with-xui" ] && [ -f "$T/x-ui.db" ] && sqlite3 "$T/x-ui.db" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$'; then
  systemctl stop x-ui 2>/dev/null||true; cp "$T/x-ui.db" /etc/x-ui/x-ui.db; systemctl start x-ui 2>/dev/null||true; echo "  x-ui.db restored (--with-xui)"
else echo "  x-ui.db nadadeh shod (makhsuse har server; baraye DR-e haman server: --with-xui)"; fi
rm -rf "$T"; pm2 restart xui-reseller xui-bot >/dev/null 2>&1 || true
echo "RESTORE DONE (safety backup: $SAFE)"
SCR
chmod +x /usr/local/bin/amirpanel-restore.sh

cat > /etc/systemd/system/amirpanel-backup.service <<'U'
[Unit]
Description=Amir Panel nightly backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/amirpanel-backup.sh
U
cat > /etc/systemd/system/amirpanel-backup.timer <<'U'
[Unit]
Description=Amir Panel nightly backup timer
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
U
systemctl daemon-reload
systemctl enable amirpanel-backup.timer >/dev/null 2>&1 && ok "Backup timer (har shab 04:00) faal shod."
[ -n "${BACKUP_CHANNEL:-}" ] || echo "  ! BACKUP_CHANNEL khali — faghat local zakhire mishavad. Baad az nasb, dar panel (setting BACKUP_CHANNEL) ya /etc/amirpanel-backup.env tanzimesh kon (bot bayad admine channel bashad)."
