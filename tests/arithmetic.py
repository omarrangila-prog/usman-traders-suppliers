#!/usr/bin/env python3
"""Checks the numbers, not just the plumbing.

Runs a trading scenario whose every figure can be worked out on paper, then
compares what the software reports against those hand-computed values. A test
that only asserts "the books balance" would pass even if every amount were
wrong by the same amount on both sides; this one asserts the amounts.

    python3 app.py 8499 &        (with UT_LOGIN=off and a fresh database)
    python3 tests/arithmetic.py 8499
"""
import json
import sys
import urllib.error
import urllib.request

PORT = next((a for a in sys.argv[1:] if a.isdigit()), "8499")
BASE = f"http://localhost:{PORT}/api"
COOKIE = {}
fails = []


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
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def expect(label, actual, wanted):
    ok = abs(float(actual) - float(wanted)) < 0.01
    print(f"  {'PASS ' if ok else 'FAIL '} {label:<44} app {actual:>12,.2f}   by hand {wanted:>12,.2f}")
    if not ok:
        fails.append(label)


# ---------------------------------------------------------------- the story
#
#   capital introduced                                    100,000
#   buy 100 units at 50            = 5,000, pay 2,000 of it
#   sell 40 units at 80            = 3,200 less 200 discount = 3,000, collect 1,000
#   counter sale 10 units at 90    =   900, paid in full
#   rent                                                    1,500
#   van 60,000 over 60 months -> one month                  1,000
#
CAPITAL, BUY_QTY, BUY_COST = 100000, 100, 50
SELL_QTY, SELL_PRICE, DISCOUNT, COLLECTED = 40, 80, 200, 1000
CASH_QTY, CASH_PRICE = 10, 90
SUPPLIER_PAID, RENT, VAN, LIFE = 2000, 1500, 60000, 60

accounts = {a["code"]: a["id"] for a in call("GET", "/accounts")}
product = {p["sku"]: p for p in call("GET", "/products")}["00006"]
supplier = call("POST", "/suppliers", {"name": "Mills"})["id"]
customer = call("POST", "/customers", {"name": "Shop"})["id"]

call("POST", "/journal", {"entry_date": "2026-03-01", "memo": "Capital", "lines": [
    {"account_id": accounts["1000"], "debit": CAPITAL},
    {"account_id": accounts["3000"], "credit": CAPITAL}]})
call("POST", "/purchases", {"supplier_id": supplier, "purchase_date": "2026-03-02", "tax": 0,
     "items": [{"product_id": product["id"], "qty": BUY_QTY, "price": BUY_COST}],
     "paid": SUPPLIER_PAID})
order = call("POST", "/orders", {"customer_id": customer, "order_date": "2026-03-05", "tax": 0,
     "discount": DISCOUNT,
     "items": [{"product_id": product["id"], "qty": SELL_QTY, "price": SELL_PRICE}]})
call("POST", f"/orders/{order['id']}/status", {"delivery_status": "Delivered"})
invoice = call("POST", f"/orders/{order['id']}/invoice", {"invoice_date": "2026-03-05"})
call("POST", f"/invoices/{invoice['id']}/payment", {"amount": COLLECTED})
call("POST", "/invoices", {"customer_id": customer, "invoice_date": "2026-03-07", "tax": 0,
     "items": [{"product_id": product["id"], "qty": CASH_QTY, "price": CASH_PRICE}],
     "paid": CASH_QTY * CASH_PRICE})
call("POST", "/expenses", {"entry_date": "2026-03-08", "amount": RENT,
                           "expense_account": "6100", "paid_from": "1000", "memo": "Rent"})
call("POST", "/assets", {"name": "Van", "purchase_date": "2026-03-01",
                         "cost": VAN, "life_months": LIFE})
call("POST", "/assets/depreciate", {"to": "2026-03-31"})

# ------------------------------------------------------------ what it should be
sold = SELL_QTY + CASH_QTY
stock_units = BUY_QTY - sold
cogs = sold * BUY_COST
sales = SELL_QTY * SELL_PRICE + CASH_QTY * CASH_PRICE
revenue = sales - DISCOUNT
depreciation = VAN / LIFE
cash = CAPITAL - SUPPLIER_PAID + COLLECTED + CASH_QTY * CASH_PRICE - RENT
receivable = (SELL_QTY * SELL_PRICE - DISCOUNT) - COLLECTED
payable = BUY_QTY * BUY_COST - SUPPLIER_PAID
inventory_value = stock_units * BUY_COST
gross = revenue - cogs
net = gross - RENT - depreciation
assets = cash + receivable + inventory_value - depreciation      # van at cost less depreciation
equity = CAPITAL + net

print("\n=== INVENTORY ===")
live = {p["sku"]: p for p in call("GET", "/products")}["00006"]
expect("units in stock", live["stock"], stock_units)
stock_row = {s["sku"]: s for s in call("GET", "/stock")}["00006"]
expect("stock valued at cost", stock_row["stock_value"], inventory_value)
moves = call("GET", f"/stock/moves?product_id={product['id']}")
expect("movements add up to stock", sum(m["qty"] for m in moves), stock_units)
inv_report = call("GET", "/reports/inventory")
expect("inventory report total value", inv_report["summary"]["cost_value"], inventory_value)

print("\n=== SALES AND MONEY OWED ===")
one = call("GET", f"/invoices/{invoice['id']}")["invoice"]
expect("invoice subtotal", one["subtotal"], SELL_QTY * SELL_PRICE)
expect("invoice total after discount", one["total"], SELL_QTY * SELL_PRICE - DISCOUNT)
expect("invoice balance owing", one["total"] - one["paid"], receivable)
expect("aging: total owed to us", call("GET", "/reports/aging")["total"], receivable)
expect("aging: total we owe", call("GET", "/reports/aging?kind=payable")["total"], payable)
sales_report = call("GET", "/reports/sales?from=2026-03-01&to=2026-03-31")
expect("sales report gross", sales_report["summary"]["total"],
       (SELL_QTY * SELL_PRICE - DISCOUNT) + CASH_QTY * CASH_PRICE)

print("\n=== PROFIT AND LOSS ===")
pl = call("GET", "/reports/profit-loss?from=2026-03-01&to=2026-03-31")
expect("revenue after discounts", pl["total_income"], revenue)
expect("cost of goods sold", pl["cost_of_sales"], cogs)
expect("gross profit", pl["gross_profit"], gross)
expect("operating expenses", pl["operating_expenses"], RENT + depreciation)
expect("net profit", pl["net_profit"], net)

print("\n=== BALANCE SHEET ===")
bs = call("GET", "/reports/balance-sheet?to=2026-03-31")
by_code = {a["code"]: a["amount"] for a in bs["assets"] + bs["liabilities"] + bs["equity"]}
expect("cash in hand", by_code.get("1000", 0), cash)
expect("accounts receivable", by_code.get("1100", 0), receivable)
expect("inventory", by_code.get("1200", 0), inventory_value)
expect("accounts payable", by_code.get("2000", 0), payable)
expect("accumulated depreciation", by_code.get("1590", 0), -depreciation)
expect("total assets", bs["total_assets"], assets)
expect("total liabilities", bs["total_liabilities"], payable)
expect("total equity", bs["total_equity"], equity)
expect("assets = liabilities + equity", bs["total_assets"],
       bs["total_liabilities"] + bs["total_equity"])

print("\n=== TRIAL BALANCE ===")
tb = call("GET", "/reports/trial-balance")
expect("debits equal credits", tb["total_debit"], tb["total_credit"])

print("\n" + "=" * 78)
print("EVERY FIGURE MATCHES" if not fails
      else f"{len(fails)} FIGURE(S) WRONG: " + ", ".join(fails))
sys.exit(1 if fails else 0)
