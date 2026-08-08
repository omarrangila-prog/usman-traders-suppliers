#!/usr/bin/env python3
"""Create the SupplyDesk schema in PocketBase and import the SQLite data.

PocketBase is a single Go binary wrapping SQLite, with a REST API, realtime
subscriptions and an admin UI. This mirrors the local schema into it and copies
the current data across. Safe to re-run: existing collections are left alone
and records are matched on their natural key.

    python3 pb_setup.py

Configure with PB_URL, PB_EMAIL, PB_PASSWORD if they differ from the defaults.
"""

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

PB_URL = os.environ.get("PB_URL", "http://127.0.0.1:8090").rstrip("/")
PB_EMAIL = os.environ.get("PB_EMAIL", "admin@usmantraders.local")
PB_PASSWORD = os.environ.get("PB_PASSWORD", "UsmanTraders2026")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "supplydesk.db")

T, N, B = "text", "number", "bool"

# collection -> [(field, type, required)]
COLLECTIONS = {
    "settings":       [("key", T, True), ("value", T, False)],
    "company":        [("name", T, True), ("tagline", T, False), ("logo", T, False),
                       ("address", T, False), ("city", T, False), ("phone", T, False),
                       ("email", T, False), ("website", T, False), ("tax_id", T, False),
                       ("currency", T, False), ("tax_rate", N, False), ("footer", T, False)],
    "app_users":      [("username", T, True), ("full_name", T, False), ("role", T, False),
                       ("password_hash", T, False), ("salt", T, False), ("active", N, False)],
    "customers":      [("name", T, True), ("contact", T, False), ("phone", T, False),
                       ("email", T, False), ("address", T, False), ("city", T, False),
                       ("tax_id", T, False), ("notes", T, False), ("active", N, False)],
    "suppliers":      [("name", T, True), ("contact", T, False), ("phone", T, False),
                       ("email", T, False), ("address", T, False), ("city", T, False),
                       ("tax_id", T, False), ("notes", T, False), ("active", N, False)],
    "products":       [("sku", T, True), ("name", T, True), ("category", T, False),
                       ("unit", T, False), ("pack_size", T, False),
                       ("purchase_price", N, False), ("sale_price", N, False),
                       ("stock", N, False), ("reorder_level", N, False),
                       ("supplier_id", T, False), ("notes", T, False), ("active", N, False)],
    "orders":         [("order_no", T, True), ("customer_id", T, False),
                       ("order_date", T, False), ("delivery_date", T, False),
                       ("status", T, False), ("delivery_status", T, False),
                       ("tracking_note", T, False), ("notes", T, False),
                       ("subtotal", N, False), ("discount", N, False), ("tax", N, False),
                       ("total", N, False), ("stock_applied", N, False)],
    "order_items":    [("order_id", T, True), ("product_id", T, True), ("qty", N, False),
                       ("price", N, False), ("line_total", N, False)],
    "invoices":       [("invoice_no", T, True), ("order_id", T, False),
                       ("customer_id", T, False), ("invoice_date", T, False),
                       ("due_date", T, False), ("subtotal", N, False), ("discount", N, False),
                       ("tax", N, False), ("total", N, False), ("paid", N, False),
                       ("status", T, False), ("notes", T, False)],
    "invoice_items":  [("invoice_id", T, True), ("product_id", T, True), ("qty", N, False),
                       ("price", N, False), ("line_total", N, False)],
    "purchases":      [("purchase_no", T, True), ("supplier_id", T, False),
                       ("purchase_date", T, False), ("bill_no", T, False),
                       ("subtotal", N, False), ("discount", N, False), ("tax", N, False),
                       ("total", N, False), ("paid", N, False), ("status", T, False),
                       ("notes", T, False), ("stock_applied", N, False)],
    "purchase_items": [("purchase_id", T, True), ("product_id", T, True), ("qty", N, False),
                       ("price", N, False), ("line_total", N, False)],
    "stock_moves":    [("product_id", T, True), ("move_date", T, False), ("kind", T, False),
                       ("qty", N, False), ("balance", N, False), ("reference", T, False),
                       ("note", T, False)],
}

# natural key used to avoid duplicating records when re-run
# text fields that must not inherit PocketBase's 5000 character default
BIG_TEXT = 2_000_000   # PocketBase treats max=0 as "use the 5000 default"
UNLIMITED = {"logo", "notes", "tagline", "address", "tracking_note"}

NATURAL_KEY = {"products": "sku", "customers": "name", "suppliers": "name",
               "orders": "order_no", "invoices": "invoice_no",
               "purchases": "purchase_no", "app_users": "username",
               "settings": "key", "company": "name"}

TOKEN = None


def call(method, path, body=None, expect_json=True):
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = TOKEN
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(PB_URL + path, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, data, timeout=30) as res:
            payload = res.read()
            return res.status, (json.loads(payload or b"{}") if expect_json else payload)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"message": raw[:200].decode(errors="replace")}
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach PocketBase at {PB_URL}: {e.reason}\n"
                 f"Start it with:  ./pocketbase/pocketbase serve --http=127.0.0.1:8090")


def authenticate():
    global TOKEN
    status, payload = call("POST", "/api/collections/_superusers/auth-with-password",
                           {"identity": PB_EMAIL, "password": PB_PASSWORD})
    if status != 200:
        sys.exit(f"Login failed ({status}): {payload.get('message')}")
    TOKEN = payload["token"]
    print(f"signed in as {PB_EMAIL}\n")


def create_collections():
    for name, fields in COLLECTIONS.items():
        spec = {
            "name": name,
            "type": "base",
            # rules left null: only an authenticated superuser (our server) may
            # touch the data, so nothing is exposed to the browser by accident
            "listRule": None, "viewRule": None,
            "createRule": None, "updateRule": None, "deleteRule": None,
            "fields": [dict({"name": f, "type": t, "required": r},
                              **({"max": BIG_TEXT} if t == T and f in UNLIMITED else {}))
                       for f, t, r in fields],
        }
        status, payload = call("POST", "/api/collections", spec)
        if status == 200:
            print(f"  created  {name} ({len(fields)} fields)")
        elif status == 400 and "already exists" in json.dumps(payload).lower():
            print(f"  exists   {name}")
        else:
            print(f"  FAILED   {name}: {status} {payload.get('message', payload)}")
            for key, err in (payload.get("data") or {}).items():
                print(f"             {key}: {err}")


def existing_keys(collection, field):
    keys, page = set(), 1
    while True:
        status, payload = call(
            "GET", f"/api/collections/{collection}/records?page={page}&perPage=200")
        if status != 200:
            return keys
        for item in payload.get("items", []):
            keys.add(str(item.get(field)))
        if page >= payload.get("totalPages", 1):
            return keys
        page += 1


def import_table(table, collection, columns):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    conn.close()
    if not rows:
        print(f"  {collection}: nothing to import")
        return

    key = NATURAL_KEY.get(collection)
    already = existing_keys(collection, key) if key else set()
    added = skipped = failed = 0
    for row in rows:
        record = {c: row[c] for c in columns if c in row.keys()}
        if key and str(record.get(key)) in already:
            skipped += 1
            continue
        status, payload = call("POST", f"/api/collections/{collection}/records", record)
        if status == 200:
            added += 1
        else:
            failed += 1
            if failed <= 2:
                print(f"     ! {payload.get('message')} {payload.get('data', '')}")
    print(f"  {collection}: {added} imported, {skipped} already there, {failed} failed")


def main():
    authenticate()
    print("collections")
    create_collections()

    print("\nimporting data from supplydesk.db")
    for table, collection in (("company", "company"), ("users", "app_users"),
                              ("customers", "customers"), ("suppliers", "suppliers"),
                              ("products", "products"), ("orders", "orders"),
                              ("order_items", "order_items"), ("invoices", "invoices"),
                              ("invoice_items", "invoice_items"), ("purchases", "purchases"),
                              ("purchase_items", "purchase_items"),
                              ("stock_moves", "stock_moves")):
        columns = [f for f, _, _ in COLLECTIONS[collection]]
        import_table(table, collection, columns)

    print(f"\nAdmin UI: {PB_URL}/_/   ({PB_EMAIL})")


if __name__ == "__main__":
    main()
