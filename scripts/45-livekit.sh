#!/usr/bin/env bash
# ماژول ۴۵: LiveKit (ویس‌چتِ مشترکِ روی صفحهٔ ساب) — اختیاری، شکست‌ناپذیر
# اگر docker یا LIVEKIT_SECRET نبود، بی‌سروصدا رد می‌شود (نصب متوقف نمی‌شود).
set -euo pipefail
ENV_FILE="$1"; CONF="${2:-}"
set -a; . "$ENV_FILE"; { [ -n "${CONF:-}" ] && [ -f "$CONF" ] && . "$CONF"; } || true; set +a
ok(){ echo "  ✓ $*"; }
warn(){ echo "  ! $*"; }

command -v docker >/dev/null 2>&1 || { warn "docker nist — LiveKit rad shod (voice gheyrefaal)."; exit 0; }
[ -n "${LIVEKIT_SECRET:-}" ] || { warn "LIVEKIT_SECRET nist — rad shod."; exit 0; }

mkdir -p /opt/amirpanel-livekit
cat > /opt/amirpanel-livekit/livekit.yaml <<YAML
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${LIVEKIT_KEY:-amirpanel}: ${LIVEKIT_SECRET}
YAML

docker rm -f amirpanel-livekit >/dev/null 2>&1 || true
docker run -d --name amirpanel-livekit --restart unless-stopped --network host \
  -v /opt/amirpanel-livekit/livekit.yaml:/livekit.yaml \
  livekit/livekit-server --config /livekit.yaml >/dev/null 2>&1 \
  && ok "LiveKit balaa amad (port 7880/7881)." || { warn "LiveKit ejra nashod."; exit 0; }

# nginx: دامنهٔ ویس → livekit (اگر VOICE_DOMAIN و گواهی باشد)
if [ -n "${VOICE_DOMAIN:-}" ] && [ -f /etc/nginx/amirpanel-cert/fullchain.pem ]; then
  cat > /etc/nginx/sites-available/voice.conf <<NGINX
map \$http_upgrade \$voice_conn { default upgrade; '' close; }
server {
    listen 80;
    listen 443 ssl http2;
    server_name ${VOICE_DOMAIN};
    ssl_certificate     /etc/nginx/amirpanel-cert/fullchain.pem;
    ssl_certificate_key /etc/nginx/amirpanel-cert/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$voice_conn;
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s; proxy_send_timeout 86400s;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/voice.conf /etc/nginx/sites-enabled/voice.conf
  nginx -t >/dev/null 2>&1 && systemctl reload nginx && ok "voice.conf (${VOICE_DOMAIN}) faal shod." || warn "nginx voice reload nashod."
  echo "  ! Yadet bashad: ${VOICE_DOMAIN} ra be IP server point kon. Seda faghat rooye VPN kar mikonad (mahdudiate WebRTC posht-e CDN)."
fi
