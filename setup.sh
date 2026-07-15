#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  نصب‌کنندهٔ خودکارِ نهان  —  کلِ اکوسیستمِ VPN رزلر در یک اجرا
#  x-ui + xray(نهان) + WARP + nginx + اسکنر IP تمیز + پنل رزلر
#
#  اجرا:  sudo bash setup.sh
#  همهٔ تنظیمات را می‌پرسد؛ هیچ secret در ریپو نیست.
#  متنِ نمایشیِ اسکریپت فینگیلیش است (ترمینالِ root فارسی را درست نشان نمی‌دهد).
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
die(){ echo "$(c '1;31' '✗ Khata:') $*" >&2; exit 1; }

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
# head لوله را زودتر می‌بندد و tr سیگنال SIGPIPE می‌گیرد (کد ۱۴۱)؛
# با pipefail+set -e این کل اسکریپت را می‌کشد، پس کد خروج را می‌بلعیم.
rand(){ local __n="${1:-16}" __s; __s="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c "$__n")" || true; printf '%s' "$__s"; }
rand_hex(){ local __n="${1:-16}" __s; __s="$(openssl rand -hex "$__n" 2>/dev/null || LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c $((__n*2)))" || true; printf '%s' "$__s"; }

VERSION="1.0.0"
banner(){
  local ncol; ncol="$(tput colors 2>/dev/null || echo 8)"
  local art=(
'      █████╗ ███╗   ███╗██╗██████╗ '
'     ██╔══██╗████╗ ████║██║██╔══██╗'
'     ███████║██╔████╔██║██║██████╔╝'
'     ██╔══██║██║╚██╔╝██║██║██╔══██╗'
'     ██║  ██║██║ ╚═╝ ██║██║██║  ██║'
'     ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═╝'
'     ██████╗  █████╗ ███╗   ██╗███████╗██╗     '
'     ██╔══██╗██╔══██╗████╗  ██║██╔════╝██║     '
'     ██████╔╝███████║██╔██╗ ██║█████╗  ██║     '
'     ██╔═══╝ ██╔══██║██║╚██╗██║██╔══╝  ██║     '
'     ██║     ██║  ██║██║ ╚████║███████╗███████╗'
'     ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝'
  )
  # طیفِ بنفش از تیره به روشن؛ اگر ترمینال ۲۵۶رنگ نبود، بنفشِ ساده
  local grad=(56 57 93 99 105 111 57 93 99 105 141 147) i=0
  echo
  for __l in "${art[@]}"; do
    if [ "${ncol:-8}" -ge 256 ] 2>/dev/null; then
      printf '\033[1;38;5;%sm%s\033[0m\n' "${grad[$i]}" "$__l"
    else
      printf '\033[1;35m%s\033[0m\n' "$__l"
    fi
    i=$((i+1))
  done
  echo
  printf '     \033[1;35m✳\033[0m \033[1mVPN Reseller Panel\033[0m \033[2m·\033[0m \033[35mNahan Edition\033[0m \033[2mv%s\033[0m\n' "$VERSION"
  printf '     \033[2mx-ui · xray · WARP · nginx · clean-ip scanner · reseller\033[0m\n'
  echo
}

# nameserverهای یک دامنه (برای گرفتنِ تایپو). اگر ابزارِ DNS نبود، خالی نه —
# رشتهٔ skip تا چکِ صدازننده اشتباهاً هشدار ندهد.
ns_of(){
  if command -v dig >/dev/null 2>&1; then dig +short NS "$1" 2>/dev/null || true
  elif command -v host >/dev/null 2>&1; then host -t NS "$1" 2>/dev/null | grep -i "name server" || true
  elif command -v nslookup >/dev/null 2>&1; then nslookup -type=NS "$1" 2>/dev/null | grep -i "nameserver" || true
  else echo "skip-no-dns-tool"; fi
}
valid_ip(){ [[ "$1" =~ ^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$ ]]; }
# چند منبع + اعتبارسنجی: بعضی سرویس‌ها از ایران صفحهٔ ۴۰۳/HTML برمی‌گردانند
detect_ip(){
  local u r
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://checkip.amazonaws.com https://ifconfig.me; do
    r="$(curl -s4 --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]')" || true
    if valid_ip "$r"; then printf '%s' "$r"; return 0; fi
  done
  r="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')" || true
  if valid_ip "$r"; then printf '%s' "$r"; return 0; fi
  return 0   # خالی — کاربر دستی می‌زند
}

[ "$(id -u)" = 0 ] || die "Ba sudo/root ejra kon."

clear 2>/dev/null || true
banner
echo "  Hameye soal ha pishfarze manteghi darand. Enter = pishfarz."
echo "  Meghdar haye hassas namayesh dade nemishavand."

# ═══════════════ ۱) دامنه‌ها ═══════════════
title "1/6  Domain ha"
echo "  Domaine asli: panel va sube poshtiban (mamulan poshte CDN dakheli mesle Arvan)."
ask MAIN_DOMAIN "Domaine asli (mesle panel.example.com)"
echo
echo "  Nahan: domaine Cloudflare ke 3 subdomaine tasadofi zirash sakhte mishavad (sube asli / zedde filter)."
ask CF_DOMAIN "Domaine Cloudflare paye, bedune subdomain (mesle example.ir)"
# گواهیِ رایگانِ Cloudflare فقط یک سطح ساب‌دامین (*.domain) را پوشش می‌دهد
CF_DOTS="${CF_DOMAIN//[^.]/}"
if [ "${#CF_DOTS}" -gt 1 ]; then
  warn "\"$CF_DOMAIN\" khodash yek subdomain ast."
  warn "Sube tasadofi rooye an mishavad 3 sath, va gavahiye rayegane Cloudflare (*.domain)"
  warn "faghat yek sath ra pushesh midahad -> TLS dar edge khata midahad."
  yesno "Bazam edame bedam?" || die "Domaine paye (mesle example.ir) ra bezan va dobare ejra kon."
fi
# دامنه باید واقعاً ثبت شده باشد — یک تایپو یعنی کلِ لایهٔ نهان روی دامنهٔ بیگانه
if [ -z "$(ns_of "$CF_DOMAIN")" ]; then
  warn "\"$CF_DOMAIN\" hich nameserveri nadarad — sabt nashode ya typo ast."
  warn "Age typo bashad, har 3 sube Nahan rooye domaine eshtebah sakhte mishavad."
  yesno "Bazam edame bedam?" || die "Emlaye domain ra check kon va dobare ejra kon."
fi
if yesno "Subdomain haye Nahan khodkar tasadofi sakhte shavand?"; then
  NSUB1="$(rand 18).$CF_DOMAIN"; NSUB2="$(rand 22).$CF_DOMAIN"; NSUB3="$(rand 16).$CF_DOMAIN"
  ok "Sakhte shod: $NSUB1 , $NSUB2 , $NSUB3"
  warn "In 3 record ra dar Cloudflare (proxy/narenji) be IPe server ezafe kon."
else
  ask NSUB1 "Subdomaine Nahan 1"; ask NSUB2 "Subdomaine Nahan 2"; ask NSUB3 "Subdomaine Nahan 3"
fi

# ═══════════════ ۲) تلگرام و ادمین ═══════════════
title "2/6  Bote Telegram va admine panel"
ask_secret BOT_TOKEN "Tokene bote Telegram (az BotFather)"
ask ADMIN_TG "IDe adadiye Telegrame admin (az @userinfobot)"
ask ADMIN_USER "Username admine panel" "admin"
ask_secret ADMIN_PASS "Ramze admine panel"
[ -n "$ADMIN_PASS" ] || die "Ramze admin khali nabashad."

# ═══════════════ ۳) x-ui ═══════════════
title "3/6  Panele x-ui (zirsakht)"
ask XUI_USER "Username x-ui" "admin"
ask_secret XUI_PASS "Ramze x-ui"
XUI_PATH="/$(rand 16)"        # مسیر پنل تصادفی (امنیت)
XUI_PORT=38339
XUI_API_KEY="$(rand 40)"      # کلید Bearer API — تولید خودکار
ok "Masire panele x-ui va kelide API tasadofi sakhte shod."

# ═══════════════ ۴) قیمت‌گذاری (پنل و ربات) ═══════════════
title "4/6  Gheymat gozari va forush"
echo "  \"Panele namayande\" = basteye amade i ke be namayande mifrushi."
ask PANEL_PRICE "Gheymate har panele namayande (Toman)" "550000"
ask PANEL_GB "Hajme panele namayande (GB)" "145"
ask PRICE_PER_GB "Gheymate har gig baraye kasr az mojudiye namayande (Toman)" "3500"
ask MAX_CLIENTS "Hadde aksare karbare har namayande" "50"
echo
if yesno "Halate \"namahdud\" faal bashad? (hajm 0 = namahdud, gheymate mahane)"; then
  UNLIMITED=1; ask UNLIM_PRICE "Gheymate mahaneye karbare namahdud (Toman)" "180000"
else UNLIMITED=0; UNLIM_PRICE=0; fi
echo
echo "  Sharzhe mojudiye namayande:"
ask CARD_NUMBER "Shomareye karte variz"
ask CARD_OWNER "Name sahebe kart"
ask CHARGE_AMOUNTS "Mabalighe amadeye sharzh (ba comma)" "500000,1000000,2000000,5000000"
PLISIO_KEY=""
if yesno "Pardakhte crypto (Plisio) faal shavad?"; then ask_secret PLISIO_KEY "Kelide API Plisio"; fi

# ═══════════════ ۵) شبکه/سرور ═══════════════
title "5/6  Server"
DETECTED_IP="$(detect_ip)"
[ -n "$DETECTED_IP" ] || warn "IP khodkar peyda nashod (service ha az server javab nadadand) — dasti bezan."
ask SERVER_IP "IPe omumiye server" "$DETECTED_IP"
while ! valid_ip "$SERVER_IP"; do
  warn "IP motabar nist. Mesle 1.2.3.4 bezan."
  ask SERVER_IP "IPe omumiye server"
done
XHTTP_PATH="/$(rand 10)"      # مسیر تونل xhttp تصادفی

# ═══════════════ تولیدِ خودکارِ کلیدها ═══════════════
title "6/6  Sakhte kelid haye amniyati"
JWT_SECRET="$(rand_hex 32)"; ok "JWT_SECRET sakhte shod."
# کلید Reality (اگر xray موجود شد در ماژول xui کامل می‌شود؛ اینجا placeholder)
ok "Kelid haye Reality dar marhaleye nasbe xray sakhte mishavand."

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
ok ".env va peykarbandi zakhire shod (600, faghat root)."

echo; echo "$(c '1;36' '  Kholaseye tanzimat:')"
echo "   Domaine asli   : $MAIN_DOMAIN"
echo "   Nahan          : $NSUB1 (+2 taye digar)"
echo "   x-ui           : port $XUI_PORT , masire tasadofi"
echo "   Gheymate panel : $PANEL_PRICE T | har gig $PRICE_PER_GB T | saghf $MAX_CLIENTS karbar"
echo
yesno "Shorue nasb ba in tanzimat?" || { warn "Laghv shod. .env zakhire shode — badan dobare ejra kon."; exit 0; }

# ═══════════════ اجرای ماژول‌های نصب ═══════════════
# ماژول‌ها پروسهٔ بچه‌اند و فقط .env/.install.conf را source می‌کنند؛ رمزِ ادمین
# عمداً در هیچ‌کدام نوشته نمی‌شود، پس باید export شود وگرنه 30-app زیر set -u
# با «ADMIN_PASS: unbound variable» می‌میرد.
export ADMIN_PASS
run_module(){ local m="$HERE/scripts/$1"; [ -f "$m" ] && { title "▶ $1"; bash "$m" "$ENV_FILE" "$CONF" || die "Module $1 shekast khord"; } || warn "Module $1 nist (rad shod)"; }
run_module 00-deps.sh
run_module 10-warp.sh
run_module 20-xui.sh
run_module 30-app.sh
run_module 40-nginx.sh
run_module 50-scanner.sh
run_module 60-tunings.sh
run_module 99-verify.sh

title "✅ AMIR PANEL — nasb kamel shod"
echo "   Panele admin : https://$MAIN_DOMAIN/panel  (user: $ADMIN_USER)"
echo "   x-ui         : http://$SERVER_IP:$XUI_PORT$XUI_PATH"
echo "   Yadet bashad: 3 recorde Nahan ra dar Cloudflare be $SERVER_IP bezan + origin ra set kon."
