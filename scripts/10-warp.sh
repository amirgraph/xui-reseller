#!/usr/bin/env bash
# ماژول ۱۰: WARP با wireproxy (userspace، پایدار) + ثبتِ تازه
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ok(){ echo "  ✓ $*"; }
die(){ echo "  ✗ $*" >&2; exit 1; }
WARP=/root/v2pn-warp
mkdir -p "$WARP"

ARCH=amd64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64

# ── دانلودِ wgcf (اگر نبود) ──
if [ ! -x "$WARP/wgcf" ]; then
  echo "  Download wgcf..."
  WGCF_VER="$(curl -s --max-time 15 https://api.github.com/repos/ViRb3/wgcf/releases/latest 2>/dev/null | jq -r .tag_name)" || true
  # اگر GitHub API جواب نداد یا rate-limit خورد، نسخهٔ پین‌شده
  case "${WGCF_VER:-}" in v[0-9]*) : ;; *) WGCF_VER=v2.2.31; echo "  ! GitHub API javab nadad — fallback be $WGCF_VER" ;; esac
  curl -fsSL -o "$WARP/wgcf" "https://github.com/ViRb3/wgcf/releases/download/${WGCF_VER}/wgcf_${WGCF_VER#v}_linux_${ARCH}" \
    || die "Downloade wgcf shekast khord: $WGCF_VER / $ARCH"
  chmod +x "$WARP/wgcf"
fi
cd "$WARP"

# ── ثبتِ حساب ──
# ⚠️ `yes | wgcf register` ممنوع: wgcf زودتر می‌بندد → yes کدِ ۱۴۱ (SIGPIPE) می‌گیرد →
#    pipefail ثبتِ *موفق* را شکست نشان می‌دهد → تلاشِ دوم روی حسابِ تازه‌ساخته‌شده
#    «existing account» می‌دهد و ماژول می‌میرد. --accept-tos خودش کافی است.
# شرط هم روی wgcf-account.toml است نه profile، وگرنه اجرای دوباره idempotent نیست.
if [ ! -f "$WARP/wgcf-account.toml" ]; then
  echo "  Sabte hesabe WARP jadid..."
  ./wgcf register --accept-tos || die "Sabte hesabe WARP shekast khord (khataye bala ra bebin)."
  ok "Hesabe WARP sabt shod."
else
  ok "Hesabe WARP az ghabl hast (rad shod)."
fi

# ── ساختِ پروفایل ──
if [ ! -f "$WARP/wgcf-profile.conf" ]; then
  ./wgcf generate || die "Sakhte profile WARP shekast khord."
  ok "Profile WARP sakhte shod."
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
