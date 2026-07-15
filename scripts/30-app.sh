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
# `|| true` لازم است: اگر placeholderی نماند grep کد ۱ می‌دهد → pipefail+set -e
{ grep -rl '__[A-Z0-9_]*__' "$APP/src" "$APP/public" 2>/dev/null || true; } | while read -r f; do
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

# ── init دیتابیس ──
# ⚠️ صرفِ require کردنِ ماژول جدولی نمی‌سازد: initDB یک تابعِ export‌شده است که
#    فقط server.js صدایش می‌زند. قبلاً require می‌شد و خطا هم خفه بود، پس
#    جدول‌ها ساخته نمی‌شدند و مرحلهٔ بعد «no such table: admins» می‌داد.
node -e "require('./src/models/database').initDB().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" \
  || die "Sakhte jadval haye database shekast khord."

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
sqlite3 "$APP/data/reseller.db" <<SQL || die "Derje gheymat ha shekast khord."
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
-- پلنِ اولیه از همان جواب‌های نصب. OR IGNORE تا اجرای دوباره‌ی نصب‌کننده
-- پلنی را که ادمین بعداً از پنل/ربات ویرایش کرده بازنویسی نکند.
INSERT OR IGNORE INTO plans(key,name,description,price,traffic_gb,max_clients,duration_days,billing,price_per_gb,is_active,sort_order)
VALUES('default','پنل نمایندگی','بستهٔ پیش‌فرض (از نصب)',$PANEL_PRICE,$PANEL_GB,$MAX_CLIENTS,0,'once',$PRICE_PER_GB,1,0);
SQL
ok "Gheymat gozari va etelaate sharzh derj shod."

# ── اجرا با pm2 ──
pm2 delete xui-reseller >/dev/null 2>&1 || true
# خفه نمی‌کنیم: اگر اپ بالا نیاید، خطای واقعیِ node را می‌خواهیم ببینیم
pm2 start "$APP/src/server.js" --name xui-reseller --cwd "$APP" || die "pm2 start (panel) shekast khord."

# ⚠️ bot.js پروسهٔ *مستقل* است (polling خودش را دارد) و server.js صدایش نمی‌زند.
#    قبلاً فقط پنل اجرا می‌شد، پس ربات هیچ‌وقت بالا نمی‌آمد — نه به‌خاطرِ توکن.
pm2 delete xui-bot >/dev/null 2>&1 || true
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  pm2 start "$APP/src/bot.js" --name xui-bot --cwd "$APP" || die "pm2 start (bot) shekast khord."
else
  echo "  ! TELEGRAM_BOT_TOKEN khalist — bot ejra nashod (panel mostaghel kar mikonad)."
fi

pm2 save >/dev/null 2>&1 || true
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
sleep 3
online(){ pm2 jlist 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);
    process.exit(p&&p.pm2_env.status==='online'?0:1)}catch(e){process.exit(1)}})" "$1"; }
if online xui-reseller; then
  ok "Panel ba pm2 ejra shod (port $PORT)."
else
  echo "  ! Panel online nashod. loge akhar:"; pm2 logs xui-reseller --lines 20 --nostream 2>&1 | tail -25 || true
  die "Panel bala nayamad."
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  if online xui-bot; then
    ok "Bot ba pm2 ejra shod."
  else
    echo "  ! Bot online nashod. loge akhar:"; pm2 logs xui-bot --lines 20 --nostream 2>&1 | tail -25 || true
    die "Bot bala nayamad."
  fi
fi
