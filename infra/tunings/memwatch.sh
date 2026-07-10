#!/bin/bash
# watchdog حافظه — نسخهٔ زودهنگام: قبل از هارد-کرشِ اوج عمل می‌کند
LOW=0; COOLDOWN=0
while true; do
  AVAIL=$(free -m | awk '/Mem:/{print $7}')
  NOW=$(date +%s)
  if [ "$AVAIL" -lt 130 ]; then
    sync; echo 1 > /proc/sys/vm/drop_caches 2>/dev/null
    A2=$(free -m | awk '/Mem:/{print $7}')
    LOW=$((LOW+1))
    echo "$(date '+%F %T') LOW avail=${AVAIL}→${A2}MB streak=$LOW" >> /root/memwatch.log
    if [ "$A2" -lt 100 ] && [ "$LOW" -ge 2 ] && [ "$NOW" -gt "$COOLDOWN" ]; then
      echo "$(date '+%F %T') PROACTIVE restart x-ui (avail=${A2}MB) — جلوگیری از هارد-کرش" >> /root/memwatch.log
      systemctl restart x-ui
      COOLDOWN=$((NOW + 300)); LOW=0; sleep 30
    fi
  else
    LOW=0
  fi
  sleep 15
done
