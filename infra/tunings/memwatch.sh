#!/bin/bash
# watchdog: قبل از هارد-کرش، پیش‌گیرانه فشار حافظه را کم می‌کند
COOLDOWN=0
while true; do
  AVAIL=$(free -m | awk '/Mem:/{print $7}')
  NOW=$(date +%s)
  if [ "$AVAIL" -lt 75 ]; then
    sync; echo 1 > /proc/sys/vm/drop_caches 2>/dev/null
    A2=$(free -m | awk '/Mem:/{print $7}')
    echo "$(date '+%F %T') LOW avail=${AVAIL}MB drop_caches→${A2}MB" >> /root/memwatch.log
    # آخرین چاره: اگر هنوز بحرانی و cooldown گذشته، x-ui را ری‌استارت کن
    if [ "$A2" -lt 45 ] && [ "$NOW" -gt "$COOLDOWN" ]; then
      echo "$(date '+%F %T') CRITICAL avail=${A2}MB → restart x-ui (جلوگیری از هارد-کرش)" >> /root/memwatch.log
      systemctl restart x-ui
      COOLDOWN=$((NOW + 180))
      sleep 30
    fi
  fi
  sleep 20
done
