#!/usr/bin/env python3
"""Create the SupplyDesk schema inside an Appwrite project.

Reads its configuration from the environment and is safe to re-run - anything
that already exists is left alone.

    export APPWRITE_ENDPOINT="https://fra.cloud.appwrite.io/v1"
    export APPWRITE_PROJECT="6a7758560009963f67b0"
    export APPWRITE_KEY="<server api key with databases scopes>"
    python3 appwrite_setup.py

Uses urllib rather than the Appwrite SDK so the project keeps its
no-dependencies promise.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = os.environ.get("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1").rstrip("/")
PROJECT = os.environ.get("APPWRITE_PROJECT", "")
API_KEY = os.environ.get("APPWRITE_KEY", "")
DATABASE_ID = os.environ.get("APPWRITE_DB", "supplydesk")

# name -> [(key, type, size/required spec)]
#   s:<size> string, i integer, d double, b boolean
SCHEMA = {
    "settings":       [("key", "s:128", True), ("value", "s:8192", True)],
    "company":        [("name", "s:256", True), ("tagline", "s:512", False),
                       ("logo", "s:1000000", False), ("address", "s:512", False),
                       ("city", "s:128", False), ("phone", "s:64", False),
                       ("email", "s:256", False), ("website", "s:256", False),
                       ("tax_id", "s:64", False), ("currency", "s:16", False),
                       ("tax_rate", "d", False), ("footer", "s:512", False)],
    "users":          [("username", "s:64", True), ("full_name", "s:128", False),
                       ("role", "s:16", True), ("password_hash", "s:256", True),
                       ("salt", "s:64", True), ("active", "i", False),
                       ("created_at", "s:32", False)],
    "customers":      [("name", "s:256", True), ("contact", "s:128", False),
                       ("phone", "s:64", False), ("email", "s:256", False),
                       ("address", "s:512", False), ("city", "s:128", False),
                       ("tax_id", "s:64", False), ("notes", "s:2048", False),
                       ("active", "i", False), ("created_at", "s:32", False)],
    "suppliers":      [("name", "s:256", True), ("contact", "s:128", False),
                       ("phone", "s:64", False), ("email", "s:256", False),
                       ("address", "s:512", False), ("city", "s:128", False),
                       ("tax_id", "s:64", False), ("notes", "s:2048", False),
                       ("active", "i", False), ("created_at", "s:32", False)],
    "products":       [("sku", "s:64", True), ("name", "s:256", True),
                       ("category", "s:128", False), ("unit", "s:32", False),
                       ("pack_size", "s:64", False), ("purchase_price", "d", False),
                       ("sale_price", "d", False), ("stock", "d", False),
                       ("reorder_level", "d", False), ("supplier_id", "s:64", False),
                       ("notes", "s:2048", False), ("active", "i", False),
                       ("created_at", "s:32", False)],
    "orders":         [("order_no", "s:32", True), ("customer_id", "s:64", True),
                       ("order_date", "s:16", True), ("delivery_date", "s:16", False),
                       ("status", "s:32", False), ("delivery_status", "s:32", False),
                       ("tracking_note", "s:512", False), ("notes", "s:2048", False),
                       ("subtotal", "d", False), ("discount", "d", False),
                       ("tax", "d", False), ("total", "d", False),
                       ("stock_applied", "i", False), ("created_at", "s:32", False)],
    "order_items":    [("order_id", "s:64", True), ("product_id", "s:64", True),
                       ("qty", "d", False), ("price", "d", False), ("line_total", "d", False)],
    "invoices":       [("invoice_no", "s:32", True), ("order_id", "s:64", False),
                       ("customer_id", "s:64", True), ("invoice_date", "s:16", True),
                       ("due_date", "s:16", False), ("subtotal", "d", False),
                       ("discount", "d", False), ("tax", "d", False), ("total", "d", False),
                       ("paid", "d", False), ("status", "s:16", False),
                       ("notes", "s:2048", False), ("created_at", "s:32", False)],
    "invoice_items":  [("invoice_id", "s:64", True), ("product_id", "s:64", True),
                       ("qty", "d", False), ("price", "d", False), ("line_total", "d", False)],
    "purchases":      [("purchase_no", "s:32", True), ("supplier_id", "s:64", True),
                       ("purchase_date", "s:16", True), ("bill_no", "s:64", False),
                       ("subtotal", "d", False), ("discount", "d", False),
                       ("tax", "d", False), ("total", "d", False), ("paid", "d", False),
                       ("status", "s:32", False), ("notes", "s:2048", False),
                       ("stock_applied", "i", False), ("created_at", "s:32", False)],
    "purchase_items": [("purchase_id", "s:64", True), ("product_id", "s:64", True),
                       ("qty", "d", False), ("price", "d", False), ("line_total", "d", False)],
    "stock_moves":    [("product_id", "s:64", True), ("move_date", "s:32", False),
                       ("kind", "s:32", True), ("qty", "d", False), ("balance", "d", False),
                       ("reference", "s:64", False), ("note", "s:256", False)],
}

# Indexes that matter for the lookups the app performs most
INDEXES = {
    "products": [("sku_idx", "unique", ["sku"])],
    "users": [("username_idx", "unique", ["username"])],
    "settings": [("key_idx", "unique", ["key"])],
    "orders": [("order_no_idx", "unique", ["order_no"]),
               ("customer_idx", "key", ["customer_id"])],
    "invoices": [("invoice_no_idx", "unique", ["invoice_no"]),
                 ("customer_idx", "key", ["customer_id"])],
    "purchases": [("purchase_no_idx", "unique", ["purchase_no"]),
                  ("supplier_idx", "key", ["supplier_id"])],
    "order_items": [("order_idx", "key", ["order_id"])],
    "invoice_items": [("invoice_idx", "key", ["invoice_id"])],
    "purchase_items": [("purchase_idx", "key", ["purchase_id"])],
    "stock_moves": [("product_idx", "key", ["product_id"])],
}


def call(method, path, body=None):
    req = urllib.request.Request(
        ENDPOINT + path, method=method,
        headers={"Content-Type": "application/json",
                 "X-Appwrite-Project": PROJECT,
                 "X-Appwrite-Key": API_KEY})
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def ensure(label, method, path, body, ok_existing=409):
    status, payload = call(method, path, body)
    if status in (200, 201):
        print(f"  created  {label}")
    elif status == ok_existing:
        print(f"  exists   {label}")
    else:
        print(f"  FAILED   {label}: {status} {payload.get('message', payload)}")
        return False
    return True


def attribute_path(collection, spec):
    kind = spec.split(":")[0]
    return {"s": "string", "i": "integer", "d": "float", "b": "boolean"}[kind]


def main():
    if not (PROJECT and API_KEY):
        sys.exit("Set APPWRITE_PROJECT and APPWRITE_KEY first (see the docstring).")

    global DATABASE_ID
    print(f"Appwrite {ENDPOINT}  project {PROJECT}\n")

    status, payload = call("POST", "/databases",
                           {"databaseId": DATABASE_ID, "name": "SupplyDesk"})
    if status in (200, 201):
        print(f"  created  database '{DATABASE_ID}'")
    elif status == 409:
        print(f"  exists   database '{DATABASE_ID}'")
    else:
        # Free plans cap how many databases you may have. If one is already
        # there, use it rather than insisting on our own name.
        print(f"  note     could not create '{DATABASE_ID}': {payload.get('message', status)}")
        _, existing = call("GET", "/databases")
        found = existing.get("databases") or []
        if not found:
            sys.exit(
                "\nNo database exists and one cannot be created on this plan.\n"
                "Free up a database in another project of the same Appwrite\n"
                "organisation, or create one in the console, then re-run.\n"
                "Point at a specific one with APPWRITE_DB=<id>.")
        DATABASE_ID = found[0]["$id"]
        print(f"  using    existing database '{DATABASE_ID}' ({found[0]['name']})")

    for collection, attributes in SCHEMA.items():
        print(f"\n{collection}")
        ensure(f"collection {collection}", "POST",
               f"/databases/{DATABASE_ID}/collections",
               {"collectionId": collection, "name": collection,
                "permissions": ['create("any")', 'read("any")',
                                'update("any")', 'delete("any")'],
                "documentSecurity": False})

        for key, spec, required in attributes:
            kind = attribute_path(collection, spec)
            body = {"key": key, "required": required}
            if kind == "string":
                body["size"] = int(spec.split(":")[1])
            if not required:
                body["default"] = "" if kind == "string" else (0 if kind != "boolean" else False)
            ensure(f"  attr {key} ({kind})", "POST",
                   f"/databases/{DATABASE_ID}/collections/{collection}/attributes/{kind}", body)
            time.sleep(0.12)   # cloud rejects bursts of schema changes

        for name, index_type, columns in INDEXES.get(collection, []):
            time.sleep(1.2)    # attributes must finish processing before indexing
            ensure(f"  index {name}", "POST",
                   f"/databases/{DATABASE_ID}/collections/{collection}/indexes",
                   {"key": name, "type": index_type, "attributes": columns})

    print("\nSchema ready.")


if __name__ == "__main__":
    main()
