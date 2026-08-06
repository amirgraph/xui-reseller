#!/usr/bin/env bash
# ماژول ۲۰: نصب x-ui (MHSanaei/3x-ui v3) + اینباند امیرپنل + قالب routing (بلاک تبلیغات)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
DB=/etc/x-ui/x-ui.db

# ── محافظ: اگر x-ui از قبل نصب است، قبل از هر تغییر بکاپِ امن بگیر ──
# نصب‌کننده باینری و پورت/مسیر/رمزِ پنل و قالبِ routing را بازنویسی می‌کند، ولی
# اینباند/کاربرانِ موجود دست‌نخورده می‌مانند (tarball هیچ x-ui.db همراه ندارد).
# با این حال بکاپ می‌گیریم تا در بدترین حالت چیزی از دست نرود.
if [ -f "$DB" ]; then
  BK="/root/x-ui-db-backup-$(date +%Y%m%d-%H%M%S).db"
  sqlite3 "$DB" ".backup '$BK'" 2>/dev/null || cp "$DB" "$BK" 2>/dev/null || true
  echo "  ! x-ui az ghabl nasb ast → backup: $BK"
  echo "    (inbound/karbarhaye feli hefz mishavand؛ faghat port/masir/passe panel va ghalebe routing reset mishavad.)"
fi

# ── استقرار باینری x-ui (بستهٔ کارکرده) ──
PKG="$HERE/releases/x-ui-amirpanel-v3.4.2.tgz"
XUI_PKG_URL="${XUI_PKG_URL:-https://github.com/amirgraph/xui-reseller/releases/download/v1.0.0/x-ui-amirpanel-v3.4.2.tgz}"
if [ ! -f "$PKG" ]; then
  mkdir -p "$HERE/releases"
  echo "  Downloade basteye x-ui az GitHub Release..."
  curl -fsSL -o "$PKG" "$XUI_PKG_URL" || { echo "Downloade baste shekast khord: $XUI_PKG_URL"; exit 1; }
fi
systemctl stop x-ui 2>/dev/null || true
mkdir -p /usr/local /etc/x-ui
tar xzf "$PKG" -C /usr/local
cp /usr/local/x-ui/x-ui.service.debian /etc/systemd/system/x-ui.service 2>/dev/null || \
  cp /usr/local/x-ui/x-ui.service.* /etc/systemd/system/x-ui.service
ln -sf /usr/local/x-ui/x-ui /usr/bin/x-ui 2>/dev/null || true
chmod +x /usr/local/x-ui/x-ui /usr/local/x-ui/bin/xray-linux-amd64
systemctl daemon-reload
ok "Binariye x-ui mostaghar shod."

# ── راه‌اندازی اولیه تا DB ساخته شود ──
systemctl enable x-ui >/dev/null 2>&1
systemctl restart x-ui; sleep 5

# ── تنظیمات پایه: پورت، مسیر، یوزر/رمز ──
/usr/local/x-ui/x-ui setting -port "$XUI_PORT" -webBasePath "$XUI_PATH" \
  -username "$XUI_USER" -password "$XUI_PASSWORD" >/dev/null 2>&1
ok "Port/masir/usere x-ui tanzim shod."

# ── قالب routing (بلاک تبلیغات + تورنت + WARP) و اینباند امیرپنل ──
XHTTP="${XHTTP_PATH#/}"   # بدون اسلش
# قالب xray: جایگزینی placeholder مسیر
sed "s|__XHTTP_PATH__|$XHTTP_PATH|g" "$HERE/infra/xray/xray-template.json" > /tmp/xray-tmpl.json
python3 - "$DB" /tmp/xray-tmpl.json "$HERE/infra/xray/amirpanel-inbound.json" "$XHTTP_PATH" <<'PY'
import sqlite3, json, sys, time
db_path, tmpl_path, inb_path, xpath = sys.argv[1:5]
db = sqlite3.connect(db_path)
# قالب routing → settings.xrayTemplateConfig
tmpl = open(tmpl_path).read()
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('xrayTemplateConfig',?)", (tmpl,))
# اینباند امیرپنل
inb = json.load(open(inb_path))
ss = json.dumps(inb["streamSettings"], ensure_ascii=False).replace("__XHTTP_PATH__", xpath)
st = json.dumps(inb["settings"], ensure_ascii=False).replace("__XHTTP_PATH__", xpath)
sniff = json.dumps({"enabled":False,"destOverride":["http","tls"]})
# حذف اینباند قدیمی با همان tag اگر بود
db.execute("DELETE FROM inbounds WHERE tag=?", ("amirpanel-xhttp",))
db.execute("""INSERT INTO inbounds
  (user_id,up,down,total,remark,enable,expiry_time,listen,port,protocol,settings,stream_settings,tag,sniffing)
  VALUES (1,0,0,0,?,1,0,?,?,?,?,?,?,?)""",
  ("امیرپنل", inb.get("listen","127.0.0.1"), inb["port"], inb["protocol"], st, ss, "amirpanel-xhttp", sniff))
db.commit(); db.close()
print("  ✓ Ghalebe routing + inbounde AmirPanel derj shod")
PY
rm -f /tmp/xray-tmpl.json

systemctl restart x-ui; sleep 6
[ "$(systemctl is-active x-ui)" = active ] && ok "x-ui faal (port $XUI_PORT)." || echo "  ! x-ui bala nayamad — barresi: journalctl -u x-ui"

# ── توکن API: تنها قدمِ نیمه‌دستی (چون x-ui توکن را سمت خودش هش می‌کند) ──
echo
echo "  ──────────────────────────────────────────────────────────"
echo "  🔑 Sakhte tokene API (yek bar, dasti):"
echo "     1) Vared sho: http://$SERVER_IP:$XUI_PORT$XUI_PATH  (user: $XUI_USER)"
echo "     2) Menuye \"API Tokens\" -> Create -> yek token besaz va copy kon"
echo "  ──────────────────────────────────────────────────────────"
read -rsp "  Tokene sakhte shode ra inja paste kon: " XUI_TOKEN; echo
if [ -n "$XUI_TOKEN" ]; then
  sed -i "s|^XUI_API_KEY=.*|XUI_API_KEY=$XUI_TOKEN|" "$ENV_FILE"
  # برای اسکریپت اسکنر/provision هم لازم است
  echo "XUI_API_KEY=$XUI_TOKEN" >> "$CONF"
  ok "Token dar .env zakhire shod."
else
  echo "  ! Token khali — badan dar .env meghdare XUI_API_KEY ra dasti bezar."
fi
