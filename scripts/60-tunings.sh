#!/usr/bin/env bash
# ماژول ۶۰: تیونینگ پایداری (درس‌های سختِ سرورِ کوچک)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ok(){ echo "  ✓ $*"; }
T="$HERE/infra/tunings"

# ── conntrack + شبکه (تحملِ برستِ ترافیک) ──
cp "$T/99-vpn-tuning.conf" /etc/sysctl.d/
cp "$T/99-swappiness.conf" /etc/sysctl.d/ 2>/dev/null || echo -e "vm.swappiness=10\nvm.vfs_cache_pressure=50" > /etc/sysctl.d/99-swappiness.conf
cp "$T/nf_conntrack.conf" /etc/modprobe.d/ 2>/dev/null || echo "options nf_conntrack hashsize=16384" > /etc/modprobe.d/nf_conntrack.conf
sysctl --system >/dev/null 2>&1 || true
echo 16384 > /sys/module/nf_conntrack/parameters/hashsize 2>/dev/null || true
ok "conntrack و sysctl تنظیم شد (max=65536، swappiness=10)."

# ── محدودکردن journald (جلوگیری از پرشدنِ دیسک با لاگ) ──
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=150M\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/99-cap.conf
systemctl restart systemd-journald 2>/dev/null || true
ok "journald محدود به ۱۵۰MB."

# ── watchdog حافظه (بلیپِ ۱۰ثانیه به‌جای هارد-کرش) ──
cp "$T/memwatch.sh" /usr/local/bin/ && chmod +x /usr/local/bin/memwatch.sh
cp "$T/memwatch.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now memwatch >/dev/null 2>&1
ok "watchdog حافظه فعال."

# ── جعبه‌سیاه (ثبتِ وضعیت هر دقیقه برای تشخیصِ کرش) ──
cp "$T/flightrec.sh" /usr/local/bin/ && chmod +x /usr/local/bin/flightrec.sh
( crontab -l 2>/dev/null | grep -v flightrec; echo "* * * * * /usr/local/bin/flightrec.sh" ) | crontab -
ok "جعبه‌سیاه فعال (/root/flightrec.log)."

# ── محافظتِ OOM برای سرویس‌های حیاتی ──
for svc in x-ui wireproxy-warp nginx; do
  mkdir -p /etc/systemd/system/$svc.service.d
  printf '[Service]\nOOMScoreAdjust=-900\n' > /etc/systemd/system/$svc.service.d/oom.conf 2>/dev/null || true
done
systemctl daemon-reload
ok "محافظتِ OOM برای x-ui/wireproxy/nginx."

# ── حذفِ سرویس‌های بی‌مصرف (RAM بیشتر) ──
for junk in snapd multipathd; do systemctl disable --now $junk 2>/dev/null || true; done
ok "سرویس‌های بی‌مصرف غیرفعال شد."
