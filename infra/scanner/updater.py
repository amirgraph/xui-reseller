#!/usr/bin/env python3
# v2pn updater — بهترین IPهای تمیز را در AMIRPANEL_ADDRS ست می‌کند و رزلر را ری‌استارت می‌کند
import json, subprocess, time, os

BASE = "/root/v2pn-cleanip"
ENVF = "/opt/xui-reseller/.env"
LOG = "/var/log/v2pn-cleanip-changes.log"

def _extra_on():
    # توگلِ «کانفیگِ اضافهٔ ضدفیلتر» در جدولِ settingsِ دیتابیسِ رزلر.
    # روشن → دو برابرِ دامنه IP تمیز نگه می‌داریم (۳ عادی + ۳ زاپاس).
    try:
        import sqlite3
        db = os.path.join(os.path.dirname(ENVF), "data", "reseller.db")
        con = sqlite3.connect(db)
        r = con.execute("SELECT value FROM settings WHERE key='antifilter_extra'").fetchone()
        con.close()
        return bool(r and str(r[0]) == "1")
    except Exception:
        return False

def _need():
    # تعداد IP تمیز = تعداد ساب‌دامنه‌ها (AMIRPANEL_SUBS)؛ هر دامنه یک IP اختصاصی.
    # اگر ادمین دامنه اضافه/کم کند، خودکار همان‌قدر IP نگه می‌داریم. حداقل ۱.
    base = 3
    try:
        for l in open(ENVF).read().splitlines():
            if l.startswith("AMIRPANEL_SUBS="):
                base = max(1, len([x for x in l.split("=", 1)[1].split(",") if x.strip()]))
                break
    except Exception:
        pass
    return base * 2 if _extra_on() else base

N = _need()  # تعداد IP تمیز (پویا = تعداد دامنه‌ها؛ اگر توگلِ زاپاس روشن باشد ×۲)

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
        # Failover (بخش۴): IP تمیزی پیدا نشد → لاگ با اولویت بالا، AMIRPANEL_ADDRS را دست نزن
        log("!!! HIGH-PRIORITY: no clean CF IP found — keeping previous AMIRPANEL_ADDRS, Reality/IPv6 fallback active")
        return
    lines = [l for l in open(ENVF).read().splitlines() if not l.startswith("AMIRPANEL_ADDRS=")]
    lines.append("AMIRPANEL_ADDRS=" + ",".join(best))
    open(ENVF, "w").write("\n".join(lines) + "\n")
    subprocess.run(["pm2", "restart", "xui-reseller", "--update-env"],
                   capture_output=True)
    log(f"updated AMIRPANEL_ADDRS={','.join(best)}  (working={res.get('working')})")
    print("AMIRPANEL_ADDRS →", best)

if __name__ == "__main__":
    main()
