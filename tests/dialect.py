#!/usr/bin/env python3
"""Every endpoint, against the database the web site actually uses.

The desktop runs on SQLite and the web site on Postgres, and the two do not
always mean the same thing by the same SQL. Two faults reached the live site
that way: an insert into a table with no id column, and a COALESCE mixing text
with a date. Both worked perfectly on SQLite.

Needs DATABASE_URL pointing at a Postgres database it may write to.

    DATABASE_URL=postgresql://... python3 tests/dialect.py [port]
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PORT = next((a for a in sys.argv[1:] if a.isdigit()), "8777")
BASE = f"http://127.0.0.1:{PORT}/api"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COOKIE = {}
fails = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  <- {detail}"))
    if not ok:
        fails.append(label)


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"Content-Type": "application/json"})
    if COOKIE:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in COOKIE.items()))
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=60) as res:
            for header in res.headers.get_all("Set-Cookie") or []:
                k, _, v = header.split(";")[0].partition("=")
                COOKIE[k] = v
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


if not os.environ.get("DATABASE_URL"):
    print("DATABASE_URL is not set; nothing to check against.")
    sys.exit(1)

server = subprocess.Popen([sys.executable, os.path.join(HERE, "app.py"), PORT],
                          cwd=HERE, env={**os.environ, "UT_LOGIN": "off"},
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=3).read()
            break
        except OSError:
            time.sleep(0.5)
    else:
        print("the server never came up:", server.stderr.read().decode()[-500:])
        sys.exit(1)

    print("\n== the shop's day, on Postgres ==")
    status, health = call("GET", "/health")
    check("it is really Postgres", health.get("storage") == "postgres", health)

    supplier = call("POST", "/suppliers", {"name": "Dialect Test Vendor"})[1]
    customer = call("POST", "/customers", {"name": "Dialect Test Shop"})[1]
    item = {p["sku"]: p for p in call("GET", "/products")[1]}["00006"]
    call("POST", "/purchases", {"supplier_id": supplier["id"], "purchase_date": "2026-09-01",
         "tax": 0, "items": [{"product_id": item["id"], "qty": 100, "price": 6}], "paid": 0})
    order = call("POST", "/orders", {"customer_id": customer["id"], "order_date": "2026-09-02",
        "tax": 0, "items": [{"product_id": item["id"], "qty": 10, "price": 10}]})[1]
    call("POST", f"/orders/{order['id']}/status", {"delivery_status": "Delivered"})
    invoice = call("POST", f"/orders/{order['id']}/invoice", {"invoice_date": "2026-09-02"})[1]
    call("POST", f"/invoices/{invoice['id']}/payment", {"amount": 50})
    call("POST", "/field/sync", {"device": "dialect", "entries": [{
        "client_id": "dialect-1", "booker": "Dialect Tester", "kind": "Booking",
        "party_name": "Dialect Booking Shop", "entry_date": "2026-09-03",
        "items": [{"sku": "00006", "qty": 2, "price": 10}]}]})
    check("a day's trading goes through", True)

    print("\n== every report answers ==")
    reports = [
        ("dashboard", "/dashboard"),
        ("sales", "/reports/sales?from=2026-09-01&to=2026-09-30"),
        ("purchases", "/reports/purchases?from=2026-09-01&to=2026-09-30"),
        ("inventory", "/reports/inventory"),
        ("booker", "/reports/bookers?from=2026-09-01&to=2026-09-30"),
        ("costing", "/reports/costing?from=2026-09-01&to=2026-09-30"),
        ("trial balance", "/reports/trial-balance"),
        ("profit and loss", "/reports/profit-loss?from=2026-09-01&to=2026-09-30"),
        ("balance sheet", "/reports/balance-sheet"),
        ("owed to us", "/reports/aging"),
        ("we owe", "/reports/aging?kind=payable"),
        ("stock", "/stock"),
        ("stock movements", "/stock/moves"),
        ("journal", "/journal"),
        ("accounts", "/accounts"),
        ("field entries", "/field/entries"),
        ("closings", "/accounting/closings"),
        ("assets", "/assets"),
    ]
    for label, path in reports:
        status, payload = call("GET", path)
        check(label, status == 200 and "error" not in payload,
              payload.get("error", "")[:90] if isinstance(payload, dict) else status)

    print("\n== every Excel export builds ==")
    for label, path in [("sales", "/reports/sales/export?from=2026-09-01&to=2026-09-30"),
                        ("purchases", "/reports/purchases/export?from=2026-09-01&to=2026-09-30"),
                        ("inventory", "/reports/inventory/export"),
                        ("item master", "/products/export"),
                        ("booker", "/reports/bookers/export?from=2026-09-01&to=2026-09-30"),
                        ("costing", "/reports/costing/export?from=2026-09-01&to=2026-09-30")]:
        try:
            req = urllib.request.Request(BASE + path)
            if COOKIE:
                req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in COOKIE.items()))
            blob = urllib.request.urlopen(req, timeout=60).read()
            check(label, blob[:2] == b"PK" and len(blob) > 1500, len(blob))
        except urllib.error.HTTPError as e:
            check(label, False, e.read()[:120])

    print("\n== sharing, which writes to tables with no id column ==")
    status, payload = call("POST", "/sync",
                           {"device": "dialect", "changes": [], "tombstones": [], "holding": {}})
    check("an exchange completes", status == 200 and payload.get("ok"),
          payload.get("error", "")[:120])
    status, payload = call("POST", "/sync",
                           {"device": "dialect", "changes": [], "tombstones": [], "holding": {}})
    check("and a second one does too", status == 200 and payload.get("ok"),
          payload.get("error", "")[:120])

    print("\n== the books still balance ==")
    tb = call("GET", "/reports/trial-balance")[1]
    check("debits equal credits",
          abs(tb.get("total_debit", 0) - tb.get("total_credit", 1)) < 0.01, tb)
finally:
    server.terminate()

print("\n" + "=" * 60)
print("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILURE(S): " + ", ".join(fails))
sys.exit(1 if fails else 0)
