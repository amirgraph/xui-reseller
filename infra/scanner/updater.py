#!/usr/bin/env python3
# v2pn updater — بهترین IPهای تمیز را در NAHAN_ADDRS ست می‌کند و رزلر را ری‌استارت می‌کند
import json, subprocess, time, os

BASE = "/root/v2pn-cleanip"
ENVF = "/opt/xui-reseller/.env"
LOG = "/var/log/v2pn-cleanip-changes.log"
N = 3  # تعداد IP تمیز برای نهان

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")

def main():
    try:
        res = json.load(open(f"{BASE}/results.json"))
    except Exception as e:
        log(f"ERROR reading results: {e}"); return
    best = [b["ip"] for b in res.get("best", [])[:N]]
    if not best:
        # Failover (بخش۴): IP تمیزی پیدا نشد → لاگ با اولویت بالا، NAHAN_ADDRS را دست نزن
        log("!!! HIGH-PRIORITY: no clean CF IP found — keeping previous NAHAN_ADDRS, Reality/IPv6 fallback active")
        return
    lines = [l for l in open(ENVF).read().splitlines() if not l.startswith("NAHAN_ADDRS=")]
    lines.append("NAHAN_ADDRS=" + ",".join(best))
    open(ENVF, "w").write("\n".join(lines) + "\n")
    subprocess.run(["pm2", "restart", "xui-reseller", "--update-env"],
                   capture_output=True)
    log(f"updated NAHAN_ADDRS={','.join(best)}  (working={res.get('working')})")
    print("NAHAN_ADDRS →", best)

if __name__ == "__main__":
    main()
