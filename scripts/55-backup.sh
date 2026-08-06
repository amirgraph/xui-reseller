#!/usr/bin/env bash
# ماژول ۵۵: بک‌آپِ خودکارِ شبانه به کانالِ تلگرام + ابزارِ بازیابی (فقط امیر پنل)
# x-ui.db + reseller.db + سورسِ پنل/بات + nahan.conf → تارِ فشرده → کانالِ تلگرام.
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
cp /etc/x-ui/x-ui.db "$TMP/" 2>/dev/null || true
cp /opt/xui-reseller/data/reseller.db "$TMP/" 2>/dev/null || true
mkdir -p "$TMP/src"; rsync -a --exclude node_modules --exclude data --exclude backups --exclude '*.bak*' /opt/xui-reseller/ "$TMP/src/" 2>/dev/null || true
cp /etc/nginx/sites-available/nahan.conf "$TMP/" 2>/dev/null || true
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
set -uo pipefail
SRC="${1:-}"; [ -f "$SRC" ] || { echo "usage: amirpanel-restore.sh <backup.tar.gz>"; exit 1; }
SAFE=/root/amirpanel-backups/pre-restore-$(date +%s); mkdir -p "$SAFE"
cp /etc/x-ui/x-ui.db "$SAFE/" 2>/dev/null || true; cp /opt/xui-reseller/data/reseller.db "$SAFE/" 2>/dev/null || true
T=$(mktemp -d); tar -xzf "$SRC" -C "$T" || exit 1
[ -f "$T/x-ui.db" ] && cp "$T/x-ui.db" /etc/x-ui/x-ui.db
[ -f "$T/reseller.db" ] && { mkdir -p /opt/xui-reseller/data; cp "$T/reseller.db" /opt/xui-reseller/data/; }
[ -d "$T/src" ] && { cp -a "$T/src/src/." /opt/xui-reseller/src/ 2>/dev/null || true; cp -a "$T/src/public/." /opt/xui-reseller/public/ 2>/dev/null || true; [ -f "$T/src/.env" ] && cp "$T/src/.env" /opt/xui-reseller/.env || true; }
[ -f "$T/nahan.conf" ] && cp "$T/nahan.conf" /etc/nginx/sites-available/nahan.conf 2>/dev/null || true
rm -rf "$T"; systemctl restart x-ui 2>/dev/null || true; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; pm2 restart all >/dev/null 2>&1 || true
echo "RESTORED (safety backup: $SAFE)"
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
