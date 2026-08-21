#!/usr/bin/env python3
"""Emit the Electron app's seed data straight from db.py.

The item master, vendor list and chart of accounts are business data. Retyping
them into JavaScript would be a chance to introduce a typo nobody would notice
until a figure came out wrong, so they are generated instead.

    python3 tools/gen-seed.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "electron", "src", "seed-data.js")


def const(name, value, comment=None):
    head = f"// {comment}\n" if comment else ""
    return f"{head}export const {name} = {json.dumps(value, ensure_ascii=False)};\n"


parts = [
    "// GENERATED from db.py by tools/gen-seed.py - do not edit by hand.\n",
    const("SCHEMA", db.SCHEMA),
    const("SCHEMA_VERSION", db.SCHEMA_VERSION),
    const("SEED_PRODUCTS", [list(r) for r in db.SEED_PRODUCTS],
          "sku, name, category, unit, pack_size, purchase_price, sale_price, stock, reorder_level"),
    const("SEED_SUPPLIERS", [list(r) for r in db.SEED_SUPPLIERS],
          "code, name, contact, phone, email, address, city"),
    const("SEED_CUSTOMERS", [list(r) for r in db.SEED_CUSTOMERS],
          "name, contact, phone, email, address, city"),
    const("CHART", [list(r) for r in db.CHART],
          "code, name, type, subtype, is_cash, system"),
    const("PLACEHOLDER_LOGO_SVG", db.PLACEHOLDER_LOGO_SVG),
]
with open(TARGET, "w", encoding="utf-8") as handle:
    handle.write("\n".join(parts))

print(f"products {len(db.SEED_PRODUCTS)}  suppliers {len(db.SEED_SUPPLIERS)}  "
      f"customers {len(db.SEED_CUSTOMERS)}  accounts {len(db.CHART)}")
