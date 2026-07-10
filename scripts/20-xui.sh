#!/usr/bin/env bash
# ماژول ۲۰: نصب x-ui (MHSanaei/3x-ui v3) + اینباند نهان + قالب routing (بلاک تبلیغات)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
DB=/etc/x-ui/x-ui.db

# ── استقرار باینری x-ui (بستهٔ کارکرده) ──
PKG="$HERE/releases/x-ui-nahan-v3.4.2.tgz"
if [ ! -f "$PKG" ]; then
  : "${XUI_PKG_URL:?بستهٔ x-ui نیست. releases/x-ui-nahan-v3.4.2.tgz را بگذار یا XUI_PKG_URL را ست کن}"
  echo "  دانلود بستهٔ x-ui..."; curl -fsSL -o "$PKG" "$XUI_PKG_URL"
fi
systemctl stop x-ui 2>/dev/null || true
mkdir -p /usr/local /etc/x-ui
tar xzf "$PKG" -C /usr/local
cp /usr/local/x-ui/x-ui.service.debian /etc/systemd/system/x-ui.service 2>/dev/null || \
  cp /usr/local/x-ui/x-ui.service.* /etc/systemd/system/x-ui.service
ln -sf /usr/local/x-ui/x-ui /usr/bin/x-ui 2>/dev/null || true
chmod +x /usr/local/x-ui/x-ui /usr/local/x-ui/bin/xray-linux-amd64
systemctl daemon-reload
ok "باینری x-ui مستقر شد."

# ── راه‌اندازی اولیه تا DB ساخته شود ──
systemctl enable x-ui >/dev/null 2>&1
systemctl restart x-ui; sleep 5

# ── تنظیمات پایه: پورت، مسیر، یوزر/رمز ──
/usr/local/x-ui/x-ui setting -port "$XUI_PORT" -webBasePath "$XUI_PATH" \
  -username "$XUI_USER" -password "$XUI_PASSWORD" >/dev/null 2>&1
ok "پورت/مسیر/یوزر x-ui تنظیم شد."

# ── قالب routing (بلاک تبلیغات + تورنت + WARP) و اینباند نهان ──
XHTTP="${XHTTP_PATH#/}"   # بدون اسلش
# قالب xray: جایگزینی placeholder مسیر
sed "s|__XHTTP_PATH__|$XHTTP_PATH|g" "$HERE/infra/xray/xray-template.json" > /tmp/xray-tmpl.json
python3 - "$DB" /tmp/xray-tmpl.json "$HERE/infra/xray/nahan-inbound.json" "$XHTTP_PATH" <<'PY'
import sqlite3, json, sys, time
db_path, tmpl_path, inb_path, xpath = sys.argv[1:5]
db = sqlite3.connect(db_path)
# قالب routing → settings.xrayTemplateConfig
tmpl = open(tmpl_path).read()
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('xrayTemplateConfig',?)", (tmpl,))
# اینباند نهان
inb = json.load(open(inb_path))
ss = json.dumps(inb["streamSettings"], ensure_ascii=False).replace("__XHTTP_PATH__", xpath)
st = json.dumps(inb["settings"], ensure_ascii=False).replace("__XHTTP_PATH__", xpath)
sniff = json.dumps({"enabled":False,"destOverride":["http","tls"]})
# حذف اینباند قدیمی با همان tag اگر بود
db.execute("DELETE FROM inbounds WHERE tag=?", ("nahan-xhttp",))
db.execute("""INSERT INTO inbounds
  (user_id,up,down,total,remark,enable,expiry_time,listen,port,protocol,settings,stream_settings,tag,sniffing)
  VALUES (1,0,0,0,?,1,0,?,?,?,?,?,?,?)""",
  ("نهان", inb.get("listen","127.0.0.1"), inb["port"], inb["protocol"], st, ss, "nahan-xhttp", sniff))
db.commit(); db.close()
print("  ✓ قالب routing + اینباند نهان درج شد")
PY
rm -f /tmp/xray-tmpl.json

systemctl restart x-ui; sleep 6
[ "$(systemctl is-active x-ui)" = active ] && ok "x-ui فعال (پورت $XUI_PORT)." || echo "  ! x-ui بالا نیامد — بررسی: journalctl -u x-ui"

# ── توکن API: تنها قدمِ نیمه‌دستی (چون x-ui توکن را سمت خودش هش می‌کند) ──
echo
echo "  ──────────────────────────────────────────────────────────"
echo "  🔑 ساختِ توکن API (یک‌بار، دستی):"
echo "     ۱) وارد شو: http://$SERVER_IP:$XUI_PORT$XUI_PATH  (یوزر: $XUI_USER)"
echo "     ۲) منوی «API Tokens» → Create → یک توکن بساز و کپی کن"
echo "  ──────────────────────────────────────────────────────────"
read -rsp "  توکن ساخته‌شده را اینجا paste کن: " XUI_TOKEN; echo
if [ -n "$XUI_TOKEN" ]; then
  sed -i "s|^XUI_API_KEY=.*|XUI_API_KEY=$XUI_TOKEN|" "$ENV_FILE"
  # برای اسکریپت اسکنر/provision هم لازم است
  echo "XUI_API_KEY=$XUI_TOKEN" >> "$CONF"
  ok "توکن در .env ذخیره شد."
else
  echo "  ! توکن خالی — بعداً در .env مقدار XUI_API_KEY را دستی بگذار."
fi
