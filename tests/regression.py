#!/usr/bin/env python3
"""End-to-end checks against a running server.

    python3 app.py 8421 &            # or any port
    python3 tests/regression.py 8421

Add --no-login when the server runs with UT_LOGIN=off.

These exercise the paths a shop actually uses - buying, selling, delivering,
invoicing, collecting - and assert the invariants that matter: stock matches
its movement ledger, and the books balance.
"""
import json
import sys
import urllib.error
import urllib.request

PORT = next((a for a in sys.argv[1:] if a.isdigit()), "8421")
OPEN_MODE = "--no-login" in sys.argv
BASE = f"http://localhost:{PORT}/api"
COOKIE = {}
fails = []


def call(method, path, body=None, expect=200):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"Content-Type": "application/json"})
    if COOKIE:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in COOKIE.items()))
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=60) as res:
            status, raw = res.status, res.read()
            for header in res.headers.get_all("Set-Cookie") or []:
                k, _, v = header.split(";")[0].partition("=")
                COOKIE[k] = v
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    payload = json.loads(raw or b"{}")
    if status != expect:
        fails.append(f"{method} {path} -> {status} (want {expect}): {payload}")
    return payload


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  <- {detail}"))
    if not ok:
        fails.append(f"{label} {detail}")


def stock_of(sku):
    return {p["sku"]: p for p in call("GET", "/products")}[sku]["stock"]


def state_of(sku):
    return {s["sku"]: s for s in call("GET", "/stock")}[sku]["stock_state"]


def books_balance():
    tb = call("GET", "/reports/trial-balance")
    bs = call("GET", "/reports/balance-sheet")
    return abs(tb["total_debit"] - tb["total_credit"]) < 0.01 and bs["balances"]


print(f"\n== access ({'open' if OPEN_MODE else 'login required'}) ==")
if OPEN_MODE:
    check("runs as admin without signing in", call("GET", "/me")["user"]["role"] == "admin")
else:
    call("GET", "/products", expect=401)
    check("unauthenticated read blocked", True)
    call("POST", "/login", {"username": "admin", "password": "nope"}, expect=401)
    check("bad password rejected", True)
    check("admin signs in",
          call("POST", "/login", {"username": "admin", "password": "admin123"})
          .get("user", {}).get("role") == "admin")

print("\n== catalogue ==")
products = call("GET", "/products")
by_sku = {p["sku"]: p for p in products}
check("64 items seeded", len(products) == 64, len(products))
check("descriptions verbatim", by_sku["00001"]["name"] == "ACHAR SACHET RS;10")
check("000049 kept distinct", "000049" in by_sku and "00049" in by_sku)
check("price read from description", by_sku["00047"]["sale_price"] == 60)
check("company seeded", call("GET", "/company")["name"] == "Usman Traders & Suppliers")
check("chart of accounts seeded", len(call("GET", "/accounts")) >= 20)

cust = call("POST", "/customers", {"name": "Rahim Kiryana Store", "city": "Karachi"})
supp = call("POST", "/suppliers", {"name": "Al-Noor Masala Mills", "city": "Multan"})
check("customer created", bool(cust.get("id")))
check("supplier created", bool(supp.get("id")))

item = by_sku["00006"]
call("PUT", f"/products/{item['id']}", dict(item, reorder_level=20))

print("\n== stock follows the transactions, with no manual step ==")
base = stock_of("00006")
call("POST", "/purchases", {"supplier_id": supp["id"], "purchase_date": "2026-08-01",
     "items": [{"product_id": item["id"], "qty": 500, "price": 7}], "paid": 1000, "tax": 0})
check("purchase raises stock", stock_of("00006") == base + 500, stock_of("00006"))
check("status becomes In Stock", state_of("00006") == "In Stock")
check("cost price updated",
      {p["sku"]: p for p in call("GET", "/products")}["00006"]["purchase_price"] == 7)

order = call("POST", "/orders", {"customer_id": cust["id"], "order_date": "2026-08-05",
    "items": [{"product_id": item["id"], "qty": 120, "price": 10}], "discount": 50, "tax": 0})
d = call("GET", f"/orders/{order['id']}")["order"]
check("order total = 120*10-50", d["total"] == 1150, d["total"])
check("placing an order does not move stock", stock_of("00006") == base + 500)
call("POST", f"/orders/{order['id']}/status", {"delivery_status": "Delivered"})
check("delivering lowers stock", stock_of("00006") == base + 380)
call("POST", f"/orders/{order['id']}/status", {"status": "Confirmed", "delivery_status": "Packed"})
check("undoing delivery returns stock", stock_of("00006") == base + 500)
call("POST", f"/orders/{order['id']}/status", {"delivery_status": "Delivered"})

inv = call("POST", f"/orders/{order['id']}/invoice", {"invoice_date": "2026-08-05"})
check("invoice from order", bool(inv.get("id")))
check("re-invoicing idempotent",
      call("POST", f"/orders/{order['id']}/invoice", {}).get("existing") is True)
check("invoicing does not deduct twice", stock_of("00006") == base + 380)
call("POST", f"/invoices/{inv['id']}/payment", {"amount": 500})
check("partial payment", call("GET", f"/invoices/{inv['id']}")["invoice"]["status"] == "Partial")
call("POST", f"/invoices/{inv['id']}/payment", {"amount": 9999})
paid = call("GET", f"/invoices/{inv['id']}")["invoice"]
check("overpayment clamped and marked Paid", paid["paid"] == 1150 and paid["status"] == "Paid")

moves = call("GET", f"/stock/moves?product_id={item['id']}")
check("movement ledger sums to stock on hand",
      abs(sum(m["qty"] for m in moves) - stock_of("00006")) < 0.001,
      (sum(m["qty"] for m in moves), stock_of("00006")))

print("\n== bookkeeping ==")
check("books balance after trading", books_balance())
codes = {a["code"] for a in call("GET", "/reports/trial-balance")["accounts"]}
check("sale posted to receivables and sales", {"1100", "4000"} <= codes, sorted(codes))
check("cost of goods posted", "5000" in codes)
check("purchase posted to payables", "2000" in codes)
pl = call("GET", "/reports/profit-loss?from=2026-08-01&to=2026-08-31")
check("gross profit = sales - cost",
      abs(pl["gross_profit"] - (pl["total_income"] - pl["cost_of_sales"])) < 0.01, pl)
accounts = {a["code"]: a["id"] for a in call("GET", "/accounts")}
call("POST", "/journal", {"entry_date": "2026-08-09", "memo": "Capital",
     "lines": [{"account_id": accounts["1000"], "debit": 5000},
               {"account_id": accounts["3000"], "credit": 5000}]})
check("manual entry accepted", books_balance())
bad = call("POST", "/journal", {"entry_date": "2026-08-09", "memo": "Wrong",
     "lines": [{"account_id": accounts["1000"], "debit": 100},
               {"account_id": accounts["3000"], "credit": 60}]}, expect=400)
check("unbalanced entry refused", "balance" in bad.get("error", "").lower(), bad)
call("POST", "/expenses", {"amount": 250, "expense_account": "6100", "paid_from": "1000"})
check("expense recorded, books still balance", books_balance())
check("account ledger drills down",
      len(call("GET", f"/reports/ledger/{accounts['1000']}")["lines"]) > 0)
check("aging reports respond",
      "total" in call("GET", "/reports/aging")
      and "total" in call("GET", "/reports/aging?kind=payable"))
call("POST", "/assets", {"name": "Van", "cost": 600000, "life_months": 60})
dep = call("POST", "/assets/depreciate", {"to": "2026-08-09"})
check("depreciation posts 600000/60", abs(dep["total"] - 10000) < 0.01, dep)
check("books balance after depreciation", books_balance())

print("\n== counter sales and stock status ==")
before = stock_of("00006")
direct = call("POST", "/invoices", {"customer_id": cust["id"], "invoice_date": "2026-08-06",
    "items": [{"product_id": item["id"], "qty": 30, "price": 10}], "paid": 300, "tax": 0})
check("counter sale deducts immediately", stock_of("00006") == before - 30)
call("DELETE", f"/invoices/{direct['id']}")
check("deleting restores stock", stock_of("00006") == before)
check("books still balance after delete", books_balance())
call("POST", "/stock/adjust", {"product_id": item["id"], "qty": -(before - 10),
                               "note": "Count correction"})
check("status becomes Low Stock near reorder level", state_of("00006") == "Low Stock",
      state_of("00006"))
call("POST", "/stock/adjust", {"product_id": item["id"], "qty": -10, "note": "Clear out"})
check("status becomes Out of Stock at zero", state_of("00006") == "Out of Stock")
call("POST", "/stock/adjust", {"product_id": item["id"], "qty": 0}, expect=400)
check("zero adjustment rejected", True)

print("\n== exports ==")
for kind in ("sales", "purchases", "inventory"):
    req = urllib.request.Request(f"{BASE}/reports/{kind}/export?from=2026-08-01&to=2026-08-31",
                                 headers={"Cookie": "; ".join(f"{k}={v}" for k, v in COOKIE.items())})
    blob = urllib.request.urlopen(req, timeout=60).read()
    check(f"{kind} exports a real xlsx", blob[:2] == b"PK" and len(blob) > 2000, len(blob))

print("\n== field entries ==")
entry = {"client_id": "regression-1", "kind": "Booking", "party_name": "Field Shop",
         "items": [{"sku": "00006", "qty": 3, "price": 10}]}
first = call("POST", "/field/sync", {"device": "test", "entries": [entry]})
again = call("POST", "/field/sync", {"device": "test", "entries": [entry]})
check("field entry stored once", first["stored"] == 1 and again["stored"] == 0, (first, again))
listed = call("GET", "/field/entries")
check("field entry visible to the office", any(
    e["client_id"] == "regression-1" for e in listed))
call("DELETE", f"/field/entries/{listed[0]['id']}")
check("field entry can be deleted", True)

print("\n== guards ==")
call("POST", "/orders", {"customer_id": cust["id"], "items": []}, expect=400)
check("empty order rejected", True)
r = call("DELETE", f"/customers/{cust['id']}", expect=409)
check("customer delete warns first", "|IMPACT|" in r.get("error", ""), r)
r = call("DELETE", f"/products/{item['id']}", expect=409)
check("item delete warns first", "|IMPACT|" in r.get("error", ""), r)
dup = call("POST", "/products", {"name": "dup", "sku": "00001"}, expect=400)
check("duplicate SKU rejected", "already used" in dup.get("error", ""), dup)
sys_acc = [a for a in call("GET", "/accounts") if a["system"]][0]
call("DELETE", f"/accounts/{sys_acc['id']}", expect=400)
check("system account protected", True)

if not OPEN_MODE:
    print("\n== roles ==")
    staff = call("POST", "/users", {"username": "shopkeeper", "password": "shop1234",
                                    "role": "staff"})
    admin_cookie = dict(COOKIE)
    COOKIE.clear()
    call("POST", "/login", {"username": "shopkeeper", "password": "shop1234"})
    call("PUT", "/company", {"name": "Hacked"}, expect=403)
    check("staff cannot edit company", True)
    call("GET", "/users", expect=403)
    check("staff cannot manage users", True)
    COOKIE.clear()
    COOKIE.update(admin_cookie)
    call("DELETE", f"/users/{staff['id']}")
    call("POST", "/logout")
    call("GET", "/products", expect=401)
    check("logout ends session", True)

print("\n" + "=" * 60)
print("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILURE(S):\n  " + "\n  ".join(fails))
sys.exit(1 if fails else 0)
