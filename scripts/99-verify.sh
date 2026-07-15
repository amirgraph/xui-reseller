#!/usr/bin/env bash
# ماژول ۹۹: بررسی سلامتِ نهایی
set -uo pipefail
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
g(){ echo "  ✓ $*"; }; b(){ echo "  ✗ $*"; }

echo "  ── Service ha ──"
for s in x-ui wireproxy-warp nginx memwatch; do
  [ "$(systemctl is-active $s 2>/dev/null)" = active ] && g "$s faal" || b "$s gheyre faal"
done
pm2 jlist 2>/dev/null | grep -q '"name":"xui-reseller"' && pm2 jlist 2>/dev/null | grep -q '"status":"online"' \
  && g "Panele reseller (pm2) online" || b "Panele reseller offline"
pm2 jlist 2>/dev/null | grep -q '"name":"xui-bot"' && g "Bote telegram (pm2) hast" || b "Bote telegram (xui-bot) ejra nashode"

echo "  ── Port ha ──"
for p in "443:nginx" "8001:xray" "40000:warp" "$PORT:node" "$XUI_PORT:x-ui"; do
  ss -ltn 2>/dev/null | grep -q ":${p%%:*} " && g "Porte ${p%%:*} (${p##*:}) baz" || b "Porte ${p%%:*} (${p##*:}) baste"
done

echo "  ── WARP ──"
OUT=$(curl -s --socks5-hostname 127.0.0.1:40000 --max-time 10 https://api.ipify.org 2>/dev/null)
[ -n "$OUT" ] && g "WARP khoruji: $OUT" || b "WARP javab nadad"

echo "  ── Tunele Nahan (locale xray:8001) ──"
XRAY=/usr/local/x-ui/bin/xray-linux-amd64
UUID=$(sqlite3 /opt/xui-reseller/data/reseller.db "SELECT xui_uuid FROM clients LIMIT 1;" 2>/dev/null || echo "")
if [ -n "$UUID" ]; then
  cat > /tmp/vt.json <<EOF
{"log":{"loglevel":"error"},"inbounds":[{"port":12099,"listen":"127.0.0.1","protocol":"socks","settings":{"auth":"noauth"}}],"outbounds":[{"protocol":"vless","settings":{"vnext":[{"address":"127.0.0.1","port":8001,"users":[{"id":"$UUID","encryption":"none"}]}]},"streamSettings":{"network":"xhttp","security":"none","xhttpSettings":{"host":"","path":"$XHTTP_PATH","mode":"auto"}}}]}
EOF
  $XRAY -c /tmp/vt.json >/dev/null 2>&1 & P=$!; sleep 4
  R=$(curl -s --socks5-hostname 127.0.0.1:12099 --max-time 10 https://api.ipify.org 2>/dev/null)
  [ -n "$R" ] && g "Tunele Nahan kar mikonad (khoruji $R)" || b "Tunele Nahan javab nadad"
  kill $P 2>/dev/null; wait $P 2>/dev/null; rm -f /tmp/vt.json
else
  echo "  (Hanuz karbari sakhte nashode — bad az sakhte avalin karbar tunel ra test kon)"
fi
echo
echo "  Kholase balast. Agar hame ✓ bud, system amade ast."
