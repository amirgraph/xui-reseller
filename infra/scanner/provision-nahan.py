#!/usr/bin/env python3
# کران: کاربر فعالِ رزلر که روی اینباندهای نهان (14=CF/TLS، 15=Reality) نیست را اضافه می‌کند
import sqlite3, json, urllib.request, sys

XUI = "http://127.0.0.1:38339__XUI_PATH__"
TK = "__XUI_API_KEY__"
INBOUNDS = {14: "nh_"}   # id → پیشوند email
RDB = "/opt/xui-reseller/data/reseller.db"

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(XUI + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TK, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

try:
    inbs = api("GET", "/panel/api/inbounds/list").get("obj", [])
except Exception as e:
    print("خطا:", e); sys.exit(1)

on = {i: set() for i in INBOUNDS}
for ib in inbs:
    if ib.get("id") in INBOUNDS:
        for cs in (ib.get("clientStats") or []):
            if cs.get("uuid"): on[ib["id"]].add(cs["uuid"])

db = sqlite3.connect(RDB)
active = [r[0] for r in db.execute("SELECT xui_uuid FROM clients WHERE is_active=1").fetchall()]
db.close()

added = 0
for iid, prefix in INBOUNDS.items():
    for uuid in active:
        if uuid in on[iid]:
            continue
        try:
            d = api("POST", "/panel/api/clients/add", {"inboundIds": [iid],
                "client": {"id": uuid, "email": prefix + uuid, "flow": "", "limitIp": 0,
                    "totalGB": 0, "expiryTime": 0, "enable": True, "tgId": 0,
                    "subId": prefix.strip("_") + uuid.replace("-", "")[:12], "security": "", "reset": 0}})
            if d.get("success"): added += 1
        except Exception:
            pass

if added:
    print(f"provision-nahan: {added} کلاینت جدید روی اینباندهای نهان اضافه شد")
