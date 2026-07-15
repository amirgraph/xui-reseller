#!/usr/bin/env bash
# ماژول ۱۰: WARP با wireproxy (userspace، پایدار) + ثبتِ تازه
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ok(){ echo "  ✓ $*"; }
WARP=/root/v2pn-warp
mkdir -p "$WARP"

ARCH=amd64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64

# ── wgcf: ثبتِ حساب WARP تازه + ساخت پروفایل ──
if [ ! -f "$WARP/wgcf-profile.conf" ]; then
  echo "  Download wgcf va sabte hesabe WARP jadid..."
  WGCF_VER=$(curl -s https://api.github.com/repos/ViRb3/wgcf/releases/latest | jq -r .tag_name)
  curl -fsSL -o "$WARP/wgcf" "https://github.com/ViRb3/wgcf/releases/download/${WGCF_VER}/wgcf_${WGCF_VER#v}_linux_${ARCH}"
  chmod +x "$WARP/wgcf"
  cd "$WARP"
  yes | ./wgcf register --accept-tos >/dev/null 2>&1 || ./wgcf register --accept-tos >/dev/null 2>&1
  ./wgcf generate >/dev/null 2>&1
  ok "Hesabe WARP sabt va profile sakhte shod."
else
  ok "Profile WARP az ghabl hast."
fi

# ── استخراجِ کلید خصوصی و ساختِ کانفیگ wireproxy از قالب ──
PRIV=$(grep -i PrivateKey "$WARP/wgcf-profile.conf" | awk '{print $3}')
sed "s|<WGCF_PRIVATE_KEY>|$PRIV|" "$HERE/infra/warp/warp-wireproxy.conf.tmpl" > "$WARP/warp-wireproxy.conf"
chmod 600 "$WARP/warp-wireproxy.conf"
ok "Configse wireproxy sakhte shod (SOCKS 127.0.0.1:40000)."

# ── دانلود wireproxy ──
if [ ! -x "$WARP/wireproxy" ]; then
  echo "  Download wireproxy..."
  WP_VER=$(curl -s https://api.github.com/repos/pufferffish/wireproxy/releases/latest | jq -r .tag_name)
  curl -fsSL -o "$WARP/wp.tar.gz" "https://github.com/pufferffish/wireproxy/releases/download/${WP_VER}/wireproxy_linux_${ARCH}.tar.gz"
  tar xzf "$WARP/wp.tar.gz" -C "$WARP" && rm -f "$WARP/wp.tar.gz"
  chmod +x "$WARP/wireproxy"
fi
ok "wireproxy amade."

# ── systemd ──
cp "$HERE/infra/warp/wireproxy-warp.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wireproxy-warp >/dev/null 2>&1
sleep 3

# ── تست خروجی WARP ──
if curl -s --socks5-hostname 127.0.0.1:40000 --max-time 10 https://api.ipify.org >/dev/null 2>&1; then
  OUT=$(curl -s --socks5-hostname 127.0.0.1:40000 --max-time 10 https://api.ipify.org)
  ok "WARP faal — khoruji: $OUT"
else
  echo "  ! WARP hanuz javab nadad — bad az bala amadan dobare check kon: systemctl status wireproxy-warp"
fi
