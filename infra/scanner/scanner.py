#!/usr/bin/env python3
# v2pn اسکنر IP تمیز Cloudflare — IPهایی که درست به zone نهان route می‌شوند و سریع/زنده‌اند
import json, random, subprocess, ipaddress, urllib.request, time, os
from concurrent.futures import ThreadPoolExecutor

BASE = "/root/v2pn-cleanip"
SUBDOMAIN = os.environ.get("NAHAN_SUB", "__NSUB1__")
PATH = "__XHTTP_PATH__"
SAMPLE_PER_RANGE = 60      # از هر رنج CF این تعداد IP تصادفی
THREADS = 120
TIMEOUT = 4

def cf_ranges():
    try:
        data = urllib.request.urlopen("https://www.cloudflare.com/ips-v4", timeout=10).read().decode()
        return [c for c in data.split() if "/" in c]
    except Exception:
        # fallback رنج‌های شناخته‌شدهٔ CF
        return ["104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","162.158.0.0/15",
                "188.114.96.0/20","141.101.64.0/18","108.162.192.0/18","173.245.48.0/20"]

def sample_ips():
    ips = []
    for cidr in cf_ranges():
        net = ipaddress.ip_network(cidr, strict=False)
        n = min(net.num_addresses - 2, SAMPLE_PER_RANGE)
        for _ in range(n):
            off = random.randint(1, net.num_addresses - 2)
            ips.append((str(net.network_address + off), cidr))
    random.shuffle(ips)
    return ips

def test_ip(item):
    ip, cidr = item
    try:
        r = subprocess.run(
            ["curl","-s","-o","/dev/null","--resolve",f"{SUBDOMAIN}:443:{ip}",
             "--max-time",str(TIMEOUT),"-w","%{http_code} %{time_total}",
             f"https://{SUBDOMAIN}{PATH}"],
            capture_output=True, text=True, timeout=TIMEOUT+2)
        p = r.stdout.split()
        # xhttp path پاسخ 404/200 می‌دهد؛ هرچه != 000 یعنی CF این IP به origin ما می‌رسد
        if len(p) == 2 and p[0] not in ("000", "522", "523", "521"):
            return {"ip": ip, "range": cidr, "code": p[0], "latency": round(float(p[1]), 3)}
    except Exception:
        pass
    return None

def main():
    os.makedirs(BASE, exist_ok=True)
    ips = sample_ips()
    results = []
    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        for res in ex.map(test_ip, ips):
            if res: results.append(res)
    results.sort(key=lambda x: x["latency"])
    # تنوع: بهترینِ هر رنج
    seen, diverse = set(), []
    for r in results:
        if r["range"] not in seen:
            seen.add(r["range"]); diverse.append(r)
    best = (diverse + results)[:15]
    out = {"updated": int(time.time()), "date": time.strftime("%Y-%m-%d %H:%M:%S"),
           "sub": SUBDOMAIN, "tested": len(ips), "working": len(results), "best": best}
    json.dump(out, open(f"{BASE}/results.json", "w"), indent=2)
    print(f"tested={len(ips)} working={len(results)} best={[b['ip'] for b in best[:5]]}")

if __name__ == "__main__":
    main()
