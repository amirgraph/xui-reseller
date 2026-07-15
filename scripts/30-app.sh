#!/usr/bin/env bash
# ماژول ۳۰: استقرار پنل/رباتِ رزلر + دیتابیس + ادمین + قیمت‌ها
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
die(){ echo "  ✗ $*" >&2; exit 1; }
APP=/opt/xui-reseller

# رمزِ ادمین فقط همین‌جا لازم است (bcrypt در DB) و عمداً در .env نوشته نمی‌شود،
# چون .env به /opt/xui-reseller/.env کپی می‌شود و اپ در زمانِ اجرا به آن نیاز ندارد.
# setup.sh آن را export می‌کند؛ در اجرای مستقلِ این ماژول همین‌جا پرسیده می‌شود.
# زودتر از npm پرسیده می‌شود تا کاربر چند دقیقه بعد غافلگیر نشود.
if [ -z "${ADMIN_PASS:-}" ]; then
  read -rsp "  Ramze admine panel (baraye sakhte admin): " ADMIN_PASS; echo
fi
[ -n "${ADMIN_PASS:-}" ] || die "Ramze admin khali nabashad."

# ── کپی کد + جایگزینی placeholderها با دامنه‌های واقعی ──
mkdir -p "$APP"
cp -a "$HERE/app/." "$APP/"
cp "$ENV_FILE" "$APP/.env"
XHTTP_NAME="${XHTTP_PATH#/}"
grep -rl '__[A-Z0-9_]*__' "$APP/src" "$APP/public" 2>/dev/null | while read -r f; do
  sed -i \
    -e "s|__MAIN_DOMAIN__|$MAIN_DOMAIN|g" \
    -e "s|__VOICE_DOMAIN__|$MAIN_DOMAIN|g" \
    -e "s|__NSUB1__|$NSUB1|g" -e "s|__NSUB2__|$NSUB2|g" -e "s|__NSUB3__|$NSUB3|g" \
    -e "s|__XHTTP_NAME__|$XHTTP_NAME|g" \
    "$f"
done
ok "Code mostaghar va domain ha jaygozin shod."

# ── وابستگی‌های node ──
cd "$APP"
echo "  Nasbe vabastegi haye node..."
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --production >/dev/null 2>&1
mkdir -p "$APP/data"
ok "Vabastegi ha nasb shod."

# ── init دیتابیس (تابع database.js جدول‌ها را می‌سازد) ──
node -e "require('./src/models/database'); setTimeout(()=>process.exit(0), 1500);" >/dev/null 2>&1 || true

# ── ساخت ادمین (bcrypt) + درج قیمت‌ها ──
node - "$ADMIN_USER" "$ADMIN_PASS" <<'NODE'
const path=require('path');
let bcrypt; try{bcrypt=require('bcrypt')}catch(e){bcrypt=require('bcryptjs')}
const Database=require('better-sqlite3');
const db=new Database(path.join(process.cwd(),'data','reseller.db'));
const [u,p]=[process.argv[2],process.argv[3]];
const h=bcrypt.hashSync(p,12);
db.prepare("INSERT INTO admins(username,password,created_at) VALUES(?,?,datetime('now')) ON CONFLICT(username) DO UPDATE SET password=excluded.password").run(u,h);
console.log("  ✓ Admin sakhte shod:",u);
db.close();
NODE

# ── قیمت‌گذاری و شارژ (جدول settings + bot_settings) ──
sqlite3 "$APP/data/reseller.db" <<SQL 2>/dev/null || true
INSERT OR REPLACE INTO settings(key,value) VALUES('panel_price','$PANEL_PRICE');
INSERT OR REPLACE INTO settings(key,value) VALUES('panel_traffic_gb','$PANEL_GB');
INSERT OR REPLACE INTO settings(key,value) VALUES('panel_price_per_gb','$PRICE_PER_GB');
INSERT OR REPLACE INTO settings(key,value) VALUES('panel_max_clients','$MAX_CLIENTS');
INSERT OR REPLACE INTO settings(key,value) VALUES('charge_card_number','$CARD_NUMBER');
INSERT OR REPLACE INTO settings(key,value) VALUES('charge_card_owner','$CARD_OWNER');
INSERT OR REPLACE INTO settings(key,value) VALUES('charge_amounts','$CHARGE_AMOUNTS');
INSERT OR REPLACE INTO settings(key,value) VALUES('unlimited_enabled','$UNLIMITED');
INSERT OR REPLACE INTO settings(key,value) VALUES('unlimited_price','$UNLIM_PRICE');
INSERT OR REPLACE INTO bot_settings(key,value) VALUES('card_number','$CARD_NUMBER');
INSERT OR REPLACE INTO bot_settings(key,value) VALUES('card_owner','$CARD_OWNER');
SQL
ok "Gheymat gozari va etelaate sharzh derj shod."

# ── اجرا با pm2 ──
pm2 delete xui-reseller >/dev/null 2>&1 || true
# خفه نمی‌کنیم: اگر اپ بالا نیاید، خطای واقعیِ node را می‌خواهیم ببینیم
pm2 start "$APP/src/server.js" --name xui-reseller --cwd "$APP" || die "pm2 start shekast khord."
pm2 save >/dev/null 2>&1 || true
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
sleep 2
if pm2 jlist 2>/dev/null | grep -q '"name":"xui-reseller".*"status":"online"'; then
  ok "Panel/bot ba pm2 ejra shod (port $PORT)."
else
  echo "  ! Panel online nashod. 20 khate akhare log:"
  pm2 logs xui-reseller --lines 20 --nostream 2>&1 | tail -25 || true
  die "Panel bala nayamad — loge bala ra bebin."
fi
