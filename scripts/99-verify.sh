#!/usr/bin/env bash
# ماژول ۹۹: بررسی سلامتِ نهایی
set -uo pipefail
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
g(){ echo "  ✓ $*"; }; b(){ echo "  ✗ $*"; }

echo "  ── سرویس‌ها ──"
for s in x-ui wireproxy-warp nginx memwatch; do
  [ "$(systemctl is-active $s 2>/dev/null)" = active ] && g "$s فعال" || b "$s غیرفعال"
done
pm2 jlist 2>/dev/null | grep -q '"status":"online"' && g "پنل رزلر (pm2) online" || b "پنل رزلر آفلاین"

echo "  ── پورت‌ها ──"
for p in "443:nginx" "8001:xray" "40000:warp" "$PORT:node" "$XUI_PORT:x-ui"; do
  ss -ltn 2>/dev/null | grep -q ":${p%%:*} " && g "پورت ${p%%:*} (${p##*:}) باز" || b "پورت ${p%%:*} (${p##*:}) بسته"
done

echo "  ── WARP ──"
OUT=$(curl -s --socks5-hostname 127.0.0.1:40000 --max-time 10 https://api.ipify.org 2>/dev/null)
[ -n "$OUT" ] && g "WARP خروجی: $OUT" || b "WARP جواب نداد"

echo "  ── تونل نهان (لوکال xray:8001) ──"
XRAY=/usr/local/x-ui/bin/xray-linux-amd64
UUID=$(sqlite3 /opt/xui-reseller/data/reseller.db "SELECT xui_uuid FROM clients LIMIT 1;" 2>/dev/null || echo "")
if [ -n "$UUID" ]; then
  cat > /tmp/vt.json <<EOF
{"log":{"loglevel":"error"},"inbounds":[{"port":12099,"listen":"127.0.0.1","protocol":"socks","settings":{"auth":"noauth"}}],"outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"127.0.0.1","port":8001,"users":[{"id":"$UUID","encryption":"none"}]}]},"streamSettings":{"network":"xhttp","security":"none","xhttpSettings":{"host":"","path":"$XHTTP_PATH","mode":"auto"}}}]}
EOF
  $XRAY -c /tmp/vt.json >/dev/null 2>&1 & P=$!; sleep 4
  R=$(curl -s --socks5-hostname 127.0.0.1:12099 --max-time 10 https://api.ipify.org 2>/dev/null)
  [ -n "$R" ] && g "تونل نهان کار می‌کند (خروجی $R)" || b "تونل نهان جواب نداد"
  kill $P 2>/dev/null; wait $P 2>/dev/null; rm -f /tmp/vt.json
else
  echo "  (هنوز کاربری ساخته نشده — بعد از ساخت اولین کاربر تونل را تست کن)"
fi
echo
echo "  خلاصه بالاست. اگر همه ✓ بود، سیستم آماده است."
