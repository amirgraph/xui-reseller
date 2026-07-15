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
# روی سرورِ تازه nf_conntrack هنوز لود نشده. `2>/dev/null` هم جلوی خطا را
# نمی‌گرفت چون خطا از خودِ echo نیست، از ریدایرکتِ شل است (فایل باز نمی‌شود).
modprobe nf_conntrack 2>/dev/null || true
if [ -w /sys/module/nf_conntrack/parameters/hashsize ]; then
  echo 16384 > /sys/module/nf_conntrack/parameters/hashsize 2>/dev/null || true
  ok "conntrack va sysctl tanzim shod (max=65536, hashsize=16384, swappiness=10)."
else
  # modprobe.d قبلاً نوشته شده، پس در لودِ بعدی/ریبوت خودش اعمال می‌شود
  ok "conntrack va sysctl tanzim shod (max=65536, swappiness=10)."
  echo "  ! nf_conntrack load nist — hashsize az /etc/modprobe.d bad az reboot emal mishavad."
fi

# ── محدودکردن journald (جلوگیری از پرشدنِ دیسک با لاگ) ──
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=150M\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/99-cap.conf
systemctl restart systemd-journald 2>/dev/null || true
ok "journald mahdud be 150MB."

# ── watchdog حافظه (بلیپِ ۱۰ثانیه به‌جای هارد-کرش) ──
cp "$T/memwatch.sh" /usr/local/bin/ && chmod +x /usr/local/bin/memwatch.sh
cp "$T/memwatch.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now memwatch >/dev/null 2>&1
ok "watchdoge hafeze faal."

# ── جعبه‌سیاه (ثبتِ وضعیت هر دقیقه برای تشخیصِ کرش) ──
cp "$T/flightrec.sh" /usr/local/bin/ && chmod +x /usr/local/bin/flightrec.sh
# همان تلهٔ crontabِ خالی که در 50-scanner توضیح داده شد
( { crontab -l 2>/dev/null || true; } | grep -v flightrec || true
  echo "* * * * * /usr/local/bin/flightrec.sh" ) | crontab -
ok "Jabe siyah faal (/root/flightrec.log)."

# ── محافظتِ OOM برای سرویس‌های حیاتی ──
for svc in x-ui wireproxy-warp nginx; do
  mkdir -p /etc/systemd/system/$svc.service.d
  printf '[Service]\nOOMScoreAdjust=-900\n' > /etc/systemd/system/$svc.service.d/oom.conf 2>/dev/null || true
done
systemctl daemon-reload
ok "Mohafezate OOM baraye x-ui/wireproxy/nginx."

# ── حذفِ سرویس‌های بی‌مصرف (RAM بیشتر) ──
for junk in snapd multipathd; do systemctl disable --now $junk 2>/dev/null || true; done
ok "Service haye bi masraf gheyre faal shod."
