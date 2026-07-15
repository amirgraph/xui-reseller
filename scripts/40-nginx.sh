#!/usr/bin/env bash
# ماژول ۴۰: nginx (پایانهٔ TLS روی 443 → تونل نهان + پنل/ساب)
# معماریِ ساده‌شده: nginx-only، بدون Apache. یک سرور روی 443 که هم /xhef را
# به xray می‌دهد هم بقیه را به node. (پشت CDN؛ CF/Arvan گواهیِ خودشان را به کاربر می‌دهند.)
set -euo pipefail
ENV_FILE="$1"; CONF="$2"
set -a; . "$ENV_FILE"; . "$CONF"; set +a
ok(){ echo "  ✓ $*"; }
die(){ echo "  ✗ $*" >&2; exit 1; }
CERTDIR=/etc/nginx/nahan-cert

# ── سینتکسِ http2 بستگی به نسخهٔ nginx دارد ──
# <1.25.1  →  `listen 443 ssl http2;`
# >=1.25.1 →  `listen 443 ssl;` + `http2 on;`  (اوبونتو ۲۴.۰۴ هنوز nginx 1.24 دارد)
ver_num(){ local a b c; IFS=. read -r a b c <<<"${1:-0.0.0}"; echo $(( ${a:-0}*1000000 + ${b:-0}*1000 + ${c:-0} )); }
NGX_VER="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || true
if [ "$(ver_num "${NGX_VER:-0.0.0}")" -ge "$(ver_num 1.25.1)" ]; then
  LISTEN_443=$'listen 0.0.0.0:443 ssl;\n    listen [::]:443 ssl;\n    http2 on;'
else
  LISTEN_443=$'listen 0.0.0.0:443 ssl http2;\n    listen [::]:443 ssl http2;'
fi
ok "nginx ${NGX_VER:-?} — syntaxe http2 tanzim shod."

# ── گواهیِ origin: self-signed (پشت CDN «Full» کافی است؛ strict نه) ──
mkdir -p "$CERTDIR"
if [ ! -f "$CERTDIR/fullchain.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERTDIR/privkey.pem" -out "$CERTDIR/fullchain.pem" \
    -subj "/CN=$MAIN_DOMAIN" \
    -addext "subjectAltName=DNS:$MAIN_DOMAIN,DNS:$NSUB1,DNS:$NSUB2,DNS:$NSUB3" >/dev/null 2>&1
fi
ok "Gavahiye origin sakhte shod (self-signed)."

# ── map برای websocket upgrade ──
cat > /etc/nginx/conf.d/upgrade.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; "" close; }
EOF

# ── سرورِ اصلی nginx روی 443 ──
cat > /etc/nginx/sites-available/nahan.conf <<EOF
# استخرِ keepalive به xray — از churnِ اتصال (packet-up) جلوگیری می‌کند
upstream nahan_xray {
    server 127.0.0.1:8001;
    keepalive 512;
    keepalive_requests 100000;
    keepalive_timeout 75s;
}

server {
    $LISTEN_443
    server_name $MAIN_DOMAIN $NSUB1 $NSUB2 $NSUB3;

    ssl_certificate     $CERTDIR/fullchain.pem;
    ssl_certificate_key $CERTDIR/privkey.pem;
    client_max_body_size 0;

    # تونل نهان (xhttp) → xray:8001  (بدون XFF تا x-ui اسپم نکند)
    location $XHTTP_PATH {
        proxy_pass http://nahan_xray;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding off;
    }

    # پنل و ساب → node:$PORT
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
    }
}
EOF
ln -sf /etc/nginx/sites-available/nahan.conf /etc/nginx/sites-enabled/nahan.conf

# ── fd limit بالا (تحملِ برستِ اتصال) ──
grep -q worker_rlimit_nofile /etc/nginx/nginx.conf || \
  sed -i '/^worker_processes/a worker_rlimit_nofile 65536;' /etc/nginx/nginx.conf
sed -i 's/worker_connections [0-9]*;/worker_connections 8192;/' /etc/nginx/nginx.conf
mkdir -p /etc/systemd/system/nginx.service.d
printf '[Service]\nLimitNOFILE=65536\n' > /etc/systemd/system/nginx.service.d/nofile.conf
systemctl daemon-reload

if nginx -t >/dev/null 2>&1; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx || { systemctl status nginx --no-pager -l 2>&1 | tail -15; die "Restarte nginx shekast khord."; }
  ok "nginx rooye 443 faal shod."
else
  echo "  ! nginx -t khata dad:"
  nginx -t 2>&1 || true
  die "Configse nginx motabar nist (bala ra bebin)."
fi
