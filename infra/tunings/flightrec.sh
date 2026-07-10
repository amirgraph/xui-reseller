#!/bin/bash
read -r ST < <(vmstat 1 2 | tail -1 | awk '{print $17}')
MEM=$(free -m | awk '/Mem:/{print $3}')
SW=$(free -m | awk '/Swap:/{print $3}')
AV=$(free -m | awk '/Mem:/{print $7}')
LOAD=$(cut -d" " -f1 /proc/loadavg)
C443=$(ss -tn 2>/dev/null | grep -c :443)
C8001=$(ss -tn 2>/dev/null | grep -c 127.0.0.1:8001)
PROCS=$(ps -e --no-headers 2>/dev/null | wc -l)
echo "$(date +'%Y-%m-%d %H:%M:%S') mem=${MEM} avail=${AV} swap=${SW} load=${LOAD} steal=${ST} c443=${C443} c8001=${C8001} procs=${PROCS}" >> /root/flightrec.log
# محدود نگه‌داشتن فایل
tail -n 3000 /root/flightrec.log > /root/flightrec.log.tmp 2>/dev/null && mv /root/flightrec.log.tmp /root/flightrec.log
