#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  نصب‌کنندهٔ خودکارِ نهان  —  کلِ اکوسیستمِ VPN رزلر در یک اجرا
#  x-ui + xray(نهان) + WARP + nginx + اسکنر IP تمیز + پنل رزلر
#
#  اجرا:  sudo bash setup.sh
#  همهٔ تنظیمات را می‌پرسد؛ هیچ secret در ریپو نیست.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
CONF="$HERE/.install.conf"     # پاسخ‌های غیرحساس برای ماژول‌های infra
export DEBIAN_FRONTEND=noninteractive

# ── رنگ و helperها ──────────────────────────────────────────
c(){ printf '\033[%sm%s\033[0m' "$1" "$2"; }
title(){ echo; echo "$(c '1;35' "▓▓ $* ▓▓")"; }
ok(){ echo "  $(c '1;32' '✓') $*"; }
warn(){ echo "  $(c '1;33' '!') $*"; }
die(){ echo "$(c '1;31' '✗ خطا:') $*" >&2; exit 1; }

ask(){ # ask VAR "سوال" "پیش‌فرض"
  local __v="$1" __q="$2" __d="${3:-}" __a
  if [ -n "$__d" ]; then read -rp "  $__q [$__d]: " __a; __a="${__a:-$__d}"
  else read -rp "  $__q: " __a; fi
  printf -v "$__v" '%s' "$__a"
}
ask_secret(){ # ask_secret VAR "سوال"  (بدون echo)
  local __v="$1" __q="$2" __a
  read -rsp "  $__q: " __a; echo
  printf -v "$__v" '%s' "$__a"
}
yesno(){ local __q="$1" __a; read -rp "  $__q (y/n) [y]: " __a; [[ "${__a:-y}" =~ ^[yY] ]]; }
rand(){ tr -dc 'a-z0-9' </dev/urandom | head -c "${1:-16}"; }
rand_hex(){ openssl rand -hex "${1:-16}" 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c $((${1:-16}*2)); }

[ "$(id -u)" = 0 ] || die "با sudo/root اجرا کن."

clear
echo "$(c '1;35' '
  ╔═══════════════════════════════════════════════╗
  ║        نصب‌کنندهٔ نهان — VPN رزلر               ║
  ║   x-ui · xray · WARP · nginx · scanner · panel ║
  ╚═══════════════════════════════════════════════╝')"
echo "  همهٔ سوال‌ها پیش‌فرضِ منطقی دارند. Enter = پیش‌فرض."
echo "  مقادیر حساس نمایش داده نمی‌شوند."

# ═══════════════ ۱) دامنه‌ها ═══════════════
title "۱/۶  دامنه‌ها"
echo "  دامنهٔ اصلی: پنل و ساب پشتیبان (معمولاً پشت CDN داخلی مثل Arvan)."
ask MAIN_DOMAIN "دامنهٔ اصلی (مثل panel.example.com)"
echo
echo "  نهان: دامنهٔ Cloudflare که ۳ ساب‌دامینِ تصادفی زیرش ساخته می‌شود (ساب اصلی/ضدفیلتر)."
ask CF_DOMAIN "دامنهٔ Cloudflare پایه (مثل example.ir)"
if yesno "ساب‌دامین‌های نهان خودکار تصادفی ساخته شوند؟"; then
  NSUB1="$(rand 18).$CF_DOMAIN"; NSUB2="$(rand 22).$CF_DOMAIN"; NSUB3="$(rand 16).$CF_DOMAIN"
  ok "ساخته شد: $NSUB1 ، $NSUB2 ، $NSUB3"
  warn "این ۳ رکورد را در Cloudflare (پروکسی/نارنجی) به IP سرور اضافه کن."
else
  ask NSUB1 "ساب‌دامین نهان ۱"; ask NSUB2 "ساب‌دامین نهان ۲"; ask NSUB3 "ساب‌دامین نهان ۳"
fi

# ═══════════════ ۲) تلگرام و ادمین ═══════════════
title "۲/۶  ربات تلگرام و ادمین پنل"
ask_secret BOT_TOKEN "توکن ربات تلگرام (از BotFather)"
ask ADMIN_TG "آیدی عددیِ تلگرامِ ادمین (از @userinfobot)"
ask ADMIN_USER "یوزرنیم ادمینِ پنل" "admin"
ask_secret ADMIN_PASS "رمز ادمینِ پنل"
[ -n "$ADMIN_PASS" ] || die "رمز ادمین خالی نباشد."

# ═══════════════ ۳) x-ui ═══════════════
title "۳/۶  پنل x-ui (زیرساخت)"
ask XUI_USER "یوزرنیم x-ui" "admin"
ask_secret XUI_PASS "رمز x-ui"
XUI_PATH="/$(rand 16)"        # مسیر پنل تصادفی (امنیت)
XUI_PORT=38339
XUI_API_KEY="$(rand 40)"      # کلید Bearer API — تولید خودکار
ok "مسیر پنل x-ui و کلید API تصادفی ساخته شد."

# ═══════════════ ۴) قیمت‌گذاری (پنل و ربات) ═══════════════
title "۴/۶  قیمت‌گذاری و فروش"
echo "  «پنلِ نماینده» = بستهٔ آماده‌ای که به نماینده می‌فروشی."
ask PANEL_PRICE "قیمت هر پنل نماینده (تومان)" "550000"
ask PANEL_GB "حجم پنل نماینده (GB)" "145"
ask PRICE_PER_GB "قیمت هر گیگ برای کسر از موجودی نماینده (تومان)" "3500"
ask MAX_CLIENTS "حداکثر کاربر هر نماینده" "50"
echo
if yesno "حالت «نامحدود» فعال باشد؟ (حجم ۰ = نامحدود، قیمت ماهانه)"; then
  UNLIMITED=1; ask UNLIM_PRICE "قیمت ماهانهٔ کاربر نامحدود (تومان)" "180000"
else UNLIMITED=0; UNLIM_PRICE=0; fi
echo
echo "  شارژ موجودیِ نماینده:"
ask CARD_NUMBER "شمارهٔ کارتِ واریز"
ask CARD_OWNER "نامِ صاحبِ کارت"
ask CHARGE_AMOUNTS "مبالغِ آمادهٔ شارژ (با کاما)" "500000,1000000,2000000,5000000"
PLISIO_KEY=""
if yesno "پرداختِ کریپتو (Plisio) فعال شود؟"; then ask_secret PLISIO_KEY "کلید API پلیزیو"; fi

# ═══════════════ ۵) شبکه/سرور ═══════════════
title "۵/۶  سرور"
DETECTED_IP="$(curl -s4 --max-time 6 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
ask SERVER_IP "IP عمومیِ سرور" "$DETECTED_IP"
XHTTP_PATH="/$(rand 10)"      # مسیر تونل xhttp تصادفی

# ═══════════════ تولیدِ خودکارِ کلیدها ═══════════════
title "۶/۶  ساختِ کلیدهای امنیتی"
JWT_SECRET="$(rand_hex 32)"; ok "JWT_SECRET ساخته شد."
# کلید Reality (اگر xray موجود شد در ماژول xui کامل می‌شود؛ اینجا placeholder)
ok "کلیدهای Reality در مرحلهٔ نصبِ xray ساخته می‌شوند."

# ═══════════════ نوشتنِ .env (بدون نمایش) ═══════════════
umask 077
cat > "$ENV_FILE" <<EOF
PORT=3000
NODE_ENV=production
DB_PATH=./data/reseller.db
JWT_SECRET=$JWT_SECRET
SERVER_IP=$SERVER_IP
XUI_URL=http://127.0.0.1:$XUI_PORT
XUI_PATH=$XUI_PATH
XUI_USERNAME=$XUI_USER
XUI_PASSWORD=$XUI_PASS
XUI_API_KEY=$XUI_API_KEY
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_ID=$ADMIN_TG
SUB_BASE_URL=https://$MAIN_DOMAIN/sub
XUI_SUB_BASE=https://$MAIN_DOMAIN/sub
NAHAN_SUBS=$NSUB1,$NSUB2,$NSUB3
SUB_BASE_FRB=https://$NSUB1/sub
NAHAN_ADDRS=
CDN_XHTTP_PATH=$XHTTP_PATH
EOF
chmod 600 "$ENV_FILE"

# پاسخ‌های غیرحساس برای ماژول‌های infra
cat > "$CONF" <<EOF
MAIN_DOMAIN=$MAIN_DOMAIN
NSUB1=$NSUB1
NSUB2=$NSUB2
NSUB3=$NSUB3
SERVER_IP=$SERVER_IP
XUI_PORT=$XUI_PORT
XUI_PATH=$XUI_PATH
XUI_API_KEY=$XUI_API_KEY
XUI_USER=$XUI_USER
XHTTP_PATH=$XHTTP_PATH
ADMIN_USER=$ADMIN_USER
PANEL_PRICE=$PANEL_PRICE
PANEL_GB=$PANEL_GB
PRICE_PER_GB=$PRICE_PER_GB
MAX_CLIENTS=$MAX_CLIENTS
UNLIMITED=$UNLIMITED
UNLIM_PRICE=$UNLIM_PRICE
CARD_NUMBER=$CARD_NUMBER
CARD_OWNER=$CARD_OWNER
CHARGE_AMOUNTS=$CHARGE_AMOUNTS
EOF
chmod 600 "$CONF"
ok ".env و پیکربندی ذخیره شد (۶۰۰، فقط root)."

echo; echo "$(c '1;36' '  خلاصهٔ تنظیمات:')"
echo "   دامنهٔ اصلی : $MAIN_DOMAIN"
echo "   نهان       : $NSUB1 (+۲ تای دیگر)"
echo "   x-ui       : پورت $XUI_PORT ، مسیرِ تصادفی"
echo "   قیمت پنل   : $PANEL_PRICE ت | هر گیگ $PRICE_PER_GB ت | سقف $MAX_CLIENTS کاربر"
echo
yesno "شروعِ نصب با این تنظیمات؟" || { warn "لغو شد. .env ذخیره شده — بعداً دوباره اجرا کن."; exit 0; }

# ═══════════════ اجرای ماژول‌های نصب ═══════════════
run_module(){ local m="$HERE/scripts/$1"; [ -f "$m" ] && { title "▶ $1"; bash "$m" "$ENV_FILE" "$CONF" || die "ماژول $1 شکست خورد"; } || warn "ماژول $1 نیست (رد شد)"; }
run_module 00-deps.sh
run_module 10-warp.sh
run_module 20-xui.sh
run_module 30-app.sh
run_module 40-nginx.sh
run_module 50-scanner.sh
run_module 60-tunings.sh
run_module 99-verify.sh

title "✅ نصب کامل شد"
echo "   پنل ادمین : https://$MAIN_DOMAIN/panel  (یوزر: $ADMIN_USER)"
echo "   x-ui      : http://$SERVER_IP:$XUI_PORT$XUI_PATH"
echo "   یادت باشد: ۳ رکورد نهان را در Cloudflare به $SERVER_IP بزن + origin را ست کن."
