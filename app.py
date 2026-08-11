#!/usr/bin/env python3
"""Usman Traders - business management server for a trading & supply company.

Runs on the Python standard library only: http.server + sqlite3.
    python3 app.py           # http://localhost:8000
    python3 app.py 9000      # custom port
"""

import hmac
import json
import mimetypes
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import appwrite_client
import db
import xlsx

# Frozen builds unpack their files to a temporary directory (sys._MEIPASS);
# a normal run just uses the source folder.
BUNDLE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BUNDLE_DIR, "static")
SESSION_HOURS = db.SESSION_HOURS
MAX_BODY = 8 * 1024 * 1024  # 8 MB, enough for a base64 logo upload

# Sign-in is required unless explicitly switched off. Turning it off is fine on
# a machine only you can reach; on anything the outside world can open it means
# anyone with the address can read and change everything.
LOGIN_REQUIRED = os.environ.get("UT_LOGIN", "on").lower() not in ("0", "off", "false", "no")

# The field phones authenticate with this shared token instead of a login, so
# the buyer never handles an admin password. Unset means the field endpoints
# fall back to requiring a normal session.
FIELD_TOKEN = os.environ.get("UT_FIELD_TOKEN", "")

ROUTES = []


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def route(method, pattern):
    """Register an API handler. Pattern is a regex; groups are passed as ints."""
    compiled = re.compile(f"^{pattern}$")

    def decorator(fn):
        ROUTES.append((method, compiled, fn))
        return fn

    return decorator


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today():
    return datetime.now().strftime("%Y-%m-%d")


def rows(cursor):
    return [dict(r) for r in cursor.fetchall()]


def num(value, default=0.0):
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return default


def text(value, default=""):
    return str(value).strip() if value is not None else default


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------

def default_user(conn):
    """Who the app runs as when sign-in is switched off: the first admin."""
    return (conn.execute(
        "SELECT * FROM users WHERE active = 1 AND role = 'admin' ORDER BY id LIMIT 1").fetchone()
        or conn.execute(
        "SELECT * FROM users WHERE active = 1 ORDER BY id LIMIT 1").fetchone())


@route("POST", r"/api/login")
def login(ctx):
    username = text(ctx.body.get("username"))
    password = text(ctx.body.get("password"))
    user = ctx.conn.execute(
        "SELECT * FROM users WHERE username = ? AND active = 1", (username,)
    ).fetchone()
    if not user or not db.verify_password(password, user["password_hash"], user["salt"]):
        raise HttpError(401, "Invalid username or password.")

    ctx.set_cookie = db.make_token(ctx.conn, user["id"])
    return {"user": {"id": user["id"], "username": user["username"],
                     "full_name": user["full_name"], "role": user["role"]}}


@route("POST", r"/api/logout")
def logout(ctx):
    ctx.clear_cookie = True
    return {"ok": True}


@route("GET", r"/api/me")
def me(ctx):
    ctx.require_user()
    return {"user": {"id": ctx.user["id"], "username": ctx.user["username"],
                     "full_name": ctx.user["full_name"], "role": ctx.user["role"]}}


@route("POST", r"/api/me/password")
def change_password(ctx):
    ctx.require_user()
    current = text(ctx.body.get("current_password"))
    new = text(ctx.body.get("new_password"))
    if len(new) < 6:
        raise HttpError(400, "New password must be at least 6 characters.")
    if not db.verify_password(current, ctx.user["password_hash"], ctx.user["salt"]):
        raise HttpError(400, "Current password is incorrect.")
    pw_hash, salt = db.hash_password(new)
    ctx.conn.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                     (pw_hash, salt, ctx.user["id"]))
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Users (admin only)
# --------------------------------------------------------------------------

@route("GET", r"/api/users")
def list_users(ctx):
    ctx.require_admin()
    return rows(ctx.conn.execute(
        "SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id"))


@route("POST", r"/api/users")
def create_user(ctx):
    ctx.require_admin()
    username = text(ctx.body.get("username")).lower()
    password = text(ctx.body.get("password"))
    if not username or len(password) < 6:
        raise HttpError(400, "Username is required and password must be 6+ characters.")
    if ctx.conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise HttpError(400, "That username already exists.")
    pw_hash, salt = db.hash_password(password)
    cur = ctx.conn.execute(
        "INSERT INTO users (username, full_name, role, password_hash, salt) VALUES (?,?,?,?,?)",
        (username, text(ctx.body.get("full_name")),
         "admin" if ctx.body.get("role") == "admin" else "staff", pw_hash, salt))
    ctx.conn.commit()
    return {"id": cur.lastrowid}


@route("PUT", r"/api/users/(\d+)")
def update_user(ctx, user_id):
    ctx.require_admin()
    body = ctx.body
    ctx.conn.execute(
        "UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?",
        (text(body.get("full_name")), "admin" if body.get("role") == "admin" else "staff",
         1 if body.get("active", 1) else 0, user_id))
    if text(body.get("password")):
        if len(text(body.get("password"))) < 6:
            raise HttpError(400, "Password must be at least 6 characters.")
        pw_hash, salt = db.hash_password(text(body.get("password")))
        ctx.conn.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                         (pw_hash, salt, user_id))
        # Signed tokens carry no server-side record, so an already-issued one
        # stays valid until it expires. Deactivate the account to cut it off now.
    ctx.conn.commit()
    return {"ok": True}


@route("DELETE", r"/api/users/(\d+)")
def delete_user(ctx, user_id):
    ctx.require_admin()
    if user_id == ctx.user["id"]:
        raise HttpError(400, "You cannot delete the account you are signed in with.")
    ctx.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Company profile
# --------------------------------------------------------------------------

COMPANY_FIELDS = ["name", "tagline", "logo", "address", "city", "phone",
                  "email", "website", "tax_id", "currency", "footer"]


@route("GET", r"/api/health")
def health(ctx):
    ctx.conn.execute("SELECT 1").fetchone()
    return {"ok": True, "time": now_iso(), "storage": "postgres" if db.IS_POSTGRES else "sqlite",
            "login_required": LOGIN_REQUIRED, "field_token_set": bool(FIELD_TOKEN)}


@route("GET", r"/api/branding")
def get_branding(ctx):
    """Name, tagline and logo only - readable before sign-in for the login screen."""
    row = ctx.conn.execute("SELECT name, tagline, logo FROM company WHERE id = 1").fetchone()
    base = {"demo": db.DEMO_MODE, "login_required": LOGIN_REQUIRED}
    return dict(row, **base) if row else base


@route("GET", r"/api/company")
def get_company(ctx):
    ctx.require_user()
    row = ctx.conn.execute("SELECT * FROM company WHERE id = 1").fetchone()
    return dict(row, demo=db.DEMO_MODE, login_required=LOGIN_REQUIRED)


@route("PUT", r"/api/company")
def update_company(ctx):
    ctx.require_admin()
    values = [text(ctx.body.get(f)) for f in COMPANY_FIELDS]
    assignments = ", ".join(f"{f} = ?" for f in COMPANY_FIELDS)
    ctx.conn.execute(f"UPDATE company SET {assignments}, tax_rate = ? WHERE id = 1",
                     (*values, num(ctx.body.get("tax_rate"))))
    ctx.conn.commit()
    return get_company(ctx)


# --------------------------------------------------------------------------
# Products
# --------------------------------------------------------------------------

@route("GET", r"/api/products")
def list_products(ctx):
    where, params = ["1=1"], []
    search = text(ctx.query.get("q"))
    if search:
        where.append("(p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ?)")
        params += [f"%{search}%"] * 3
    if ctx.query.get("category"):
        where.append("p.category = ?")
        params.append(ctx.query["category"])
    if ctx.query.get("low") == "1":
        where.append("p.stock <= p.reorder_level")
    ctx.require_user()
    return rows(ctx.conn.execute(
        f"""SELECT p.*, s.name AS supplier_name
            FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
            WHERE {' AND '.join(where)} ORDER BY p.name""", params))


def product_payload(body):
    return (
        text(body.get("sku")).upper(), text(body.get("name")), text(body.get("category")),
        text(body.get("unit"), "pcs") or "pcs", text(body.get("pack_size")),
        num(body.get("purchase_price")), num(body.get("sale_price")),
        num(body.get("reorder_level")),
        int(body["supplier_id"]) if body.get("supplier_id") else None,
        text(body.get("notes")), 1 if body.get("active", 1) else 0,
    )


@route("POST", r"/api/products")
def create_product(ctx):
    ctx.require_user()
    if not text(ctx.body.get("name")):
        raise HttpError(400, "Product name is required.")
    payload = list(product_payload(ctx.body))
    if not payload[0]:
        payload[0] = db.next_number(ctx.conn, "products", "sku", "SKU")
    if ctx.conn.execute("SELECT 1 FROM products WHERE sku = ?", (payload[0],)).fetchone():
        raise HttpError(400, f"SKU {payload[0]} is already used by another product.")
    opening = num(ctx.body.get("stock"))
    cur = ctx.conn.execute(
        """INSERT INTO products (sku, name, category, unit, pack_size, purchase_price,
                                 sale_price, reorder_level, supplier_id, notes, active, stock)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", (*payload, opening))
    if opening:
        log_move(ctx.conn, cur.lastrowid, "Opening", opening, "OPENING", "Opening stock")
    ctx.conn.commit()
    return {"id": cur.lastrowid}


@route("PUT", r"/api/products/(\d+)")
def update_product(ctx, product_id):
    ctx.require_user()
    payload = product_payload(ctx.body)
    if ctx.conn.execute("SELECT 1 FROM products WHERE sku = ? AND id <> ?",
                        (payload[0], product_id)).fetchone():
        raise HttpError(400, f"SKU {payload[0]} is already used by another product.")
    ctx.conn.execute(
        """UPDATE products SET sku=?, name=?, category=?, unit=?, pack_size=?, purchase_price=?,
                               sale_price=?, reorder_level=?, supplier_id=?, notes=?, active=?
           WHERE id = ?""", (*payload, product_id))
    ctx.conn.commit()
    return {"ok": True}


@route("DELETE", r"/api/products/(\d+)")
def delete_product(ctx, product_id):
    ctx.require_user()
    counts = dict(ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM order_items WHERE product_id = ?)    AS order_lines,
                  (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?)  AS invoice_lines,
                  (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?) AS purchase_lines,
                  (SELECT COUNT(*) FROM stock_moves WHERE product_id = ?)    AS movements""",
        (product_id,) * 4).fetchone())
    used = sum(counts.values())
    if used and not wants_cascade(ctx):
        blocked("This item appears on saved documents.", counts)
    if used:
        # Reverse the documents first so stock and totals never go stale.
        for table, column in (("order_items", "order_id"), ("invoice_items", "invoice_id"),
                              ("purchase_items", "purchase_id")):
            ids = [r[column] for r in ctx.conn.execute(
                f"SELECT DISTINCT {column} FROM {table} WHERE product_id = ?",
                (product_id,)).fetchall()]
            for doc_id in ids:
                if table == "order_items":
                    purge_order(ctx.conn, doc_id)
                elif table == "invoice_items":
                    purge_invoice(ctx.conn, doc_id)
                else:
                    purge_purchase(ctx.conn, doc_id)
        ctx.conn.execute("DELETE FROM stock_moves WHERE product_id = ?", (product_id,))
    ctx.conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
    ctx.conn.commit()
    return {"ok": True, "removed": counts}


# --------------------------------------------------------------------------
# Customers & suppliers (identical shape, shared handlers)
# --------------------------------------------------------------------------

PARTY_FIELDS = ["name", "contact", "phone", "email", "address", "city", "tax_id", "notes"]


def party_list(ctx, table):
    ctx.require_user()
    search = text(ctx.query.get("q"))
    if search:
        like = f"%{search}%"
        return rows(ctx.conn.execute(
            f"SELECT * FROM {table} WHERE name LIKE ? OR contact LIKE ? OR phone LIKE ? OR city LIKE ?"
            " ORDER BY name", (like, like, like, like)))
    return rows(ctx.conn.execute(f"SELECT * FROM {table} ORDER BY name"))


def party_save(ctx, table, party_id=None):
    ctx.require_user()
    if not text(ctx.body.get("name")):
        raise HttpError(400, "Name is required.")
    values = [text(ctx.body.get(f)) for f in PARTY_FIELDS]
    active = 1 if ctx.body.get("active", 1) else 0
    if party_id:
        assignments = ", ".join(f"{f} = ?" for f in PARTY_FIELDS)
        ctx.conn.execute(f"UPDATE {table} SET {assignments}, active = ? WHERE id = ?",
                         (*values, active, party_id))
        ctx.conn.commit()
        return {"id": party_id}
    columns = ", ".join(PARTY_FIELDS)
    placeholders = ", ".join("?" * len(PARTY_FIELDS))
    cur = ctx.conn.execute(
        f"INSERT INTO {table} ({columns}, active) VALUES ({placeholders}, ?)", (*values, active))
    ctx.conn.commit()
    return {"id": cur.lastrowid}


@route("GET", r"/api/customers")
def list_customers(ctx):
    return party_list(ctx, "customers")


@route("POST", r"/api/customers")
def create_customer(ctx):
    return party_save(ctx, "customers")


@route("PUT", r"/api/customers/(\d+)")
def update_customer(ctx, customer_id):
    return party_save(ctx, "customers", customer_id)


@route("DELETE", r"/api/customers/(\d+)")
def delete_customer(ctx, customer_id):
    ctx.require_user()
    counts = dict(ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM orders WHERE customer_id = ?)   AS orders,
                  (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) AS invoices""",
        (customer_id, customer_id)).fetchone())
    if sum(counts.values()) and not wants_cascade(ctx):
        blocked("This customer has saved documents.", counts)
    for row in ctx.conn.execute(
            "SELECT id FROM invoices WHERE customer_id = ? AND order_id IS NULL",
            (customer_id,)).fetchall():
        purge_invoice(ctx.conn, row["id"])
    for row in ctx.conn.execute(
            "SELECT id FROM orders WHERE customer_id = ?", (customer_id,)).fetchall():
        purge_order(ctx.conn, row["id"])
    ctx.conn.execute("DELETE FROM invoices WHERE customer_id = ?", (customer_id,))
    ctx.conn.execute("DELETE FROM customers WHERE id = ?", (customer_id,))
    ctx.conn.commit()
    return {"ok": True, "removed": counts}


@route("GET", r"/api/customers/(\d+)/ledger")
def customer_ledger(ctx, customer_id):
    ctx.require_user()
    return {
        "customer": dict(ctx.conn.execute(
            "SELECT * FROM customers WHERE id = ?", (customer_id,)).fetchone() or {}),
        "orders": rows(ctx.conn.execute(
            "SELECT * FROM orders WHERE customer_id = ? ORDER BY order_date DESC, id DESC",
            (customer_id,))),
        "invoices": rows(ctx.conn.execute(
            "SELECT * FROM invoices WHERE customer_id = ? ORDER BY invoice_date DESC, id DESC",
            (customer_id,))),
    }


@route("GET", r"/api/suppliers")
def list_suppliers(ctx):
    return party_list(ctx, "suppliers")


@route("POST", r"/api/suppliers")
def create_supplier(ctx):
    return party_save(ctx, "suppliers")


@route("PUT", r"/api/suppliers/(\d+)")
def update_supplier(ctx, supplier_id):
    return party_save(ctx, "suppliers", supplier_id)


@route("DELETE", r"/api/suppliers/(\d+)")
def delete_supplier(ctx, supplier_id):
    ctx.require_user()
    counts = dict(ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM purchases WHERE supplier_id = ?) AS purchases,
                  (SELECT COUNT(*) FROM products WHERE supplier_id = ?)  AS linked_items""",
        (supplier_id, supplier_id)).fetchone())
    if sum(counts.values()) and not wants_cascade(ctx):
        blocked("This supplier has saved documents.", counts)
    for row in ctx.conn.execute(
            "SELECT id FROM purchases WHERE supplier_id = ?", (supplier_id,)).fetchall():
        purge_purchase(ctx.conn, row["id"])
    ctx.conn.execute("UPDATE products SET supplier_id = NULL WHERE supplier_id = ?", (supplier_id,))
    ctx.conn.execute("DELETE FROM suppliers WHERE id = ?", (supplier_id,))
    ctx.conn.commit()
    return {"ok": True, "removed": counts}


# --------------------------------------------------------------------------
# Stock helpers
# --------------------------------------------------------------------------

def log_move(conn, product_id, kind, qty, reference, note=""):
    """Apply a stock delta and record it in the movement ledger."""
    conn.execute("UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id = ?", (qty, product_id))
    balance = conn.execute("SELECT stock FROM products WHERE id = ?", (product_id,)).fetchone()["stock"]
    conn.execute(
        """INSERT INTO stock_moves (product_id, move_date, kind, qty, balance, reference, note)
           VALUES (?,?,?,?,?,?,?)""",
        (product_id, now_iso(), kind, qty, balance, reference, note))


def read_items(body):
    """Normalise and validate the line items posted from the UI."""
    items = []
    for raw in body.get("items") or []:
        if not raw.get("product_id"):
            continue
        qty, price = num(raw.get("qty")), num(raw.get("price"))
        if qty <= 0:
            continue
        items.append({"product_id": int(raw["product_id"]), "qty": qty, "price": price,
                      "line_total": round(qty * price, 2)})
    if not items:
        raise HttpError(400, "Add at least one line item with a quantity greater than zero.")
    return items


def totals_from(items, body):
    subtotal = round(sum(i["line_total"] for i in items), 2)
    discount = num(body.get("discount"))
    tax_rate = num(body.get("tax_rate"))
    tax = num(body.get("tax")) if body.get("tax") is not None else round(
        (subtotal - discount) * tax_rate / 100, 2)
    return subtotal, discount, tax, round(subtotal - discount + tax, 2)


# --------------------------------------------------------------------------
# Orders
# --------------------------------------------------------------------------

ORDER_STATUSES = ["Pending", "Confirmed", "Delivered", "Cancelled"]
DELIVERY_STATUSES = ["Not Dispatched", "Packed", "Dispatched", "In Transit", "Delivered", "Returned"]


@route("GET", r"/api/orders")
def list_orders(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    for key, column in (("status", "o.status"), ("delivery_status", "o.delivery_status"),
                        ("customer_id", "o.customer_id")):
        if ctx.query.get(key):
            where.append(f"{column} = ?")
            params.append(ctx.query[key])
    if ctx.query.get("from"):
        where.append("o.order_date >= ?")
        params.append(ctx.query["from"])
    if ctx.query.get("to"):
        where.append("o.order_date <= ?")
        params.append(ctx.query["to"])
    if text(ctx.query.get("q")):
        where.append("(o.order_no LIKE ? OR c.name LIKE ?)")
        params += [f"%{ctx.query['q']}%"] * 2
    return rows(ctx.conn.execute(
        f"""SELECT o.*, c.name AS customer_name, c.city AS customer_city,
                   (SELECT invoice_no FROM invoices WHERE order_id = o.id LIMIT 1) AS invoice_no
            FROM orders o JOIN customers c ON c.id = o.customer_id
            WHERE {' AND '.join(where)}
            ORDER BY o.order_date DESC, o.id DESC""", params))


@route("GET", r"/api/orders/(\d+)")
def get_order(ctx, order_id):
    ctx.require_user()
    order = ctx.conn.execute(
        """SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
                  c.address AS customer_address, c.city AS customer_city, c.tax_id AS customer_tax_id
           FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?""",
        (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    items = rows(ctx.conn.execute(
        """SELECT oi.*, p.name AS product_name, p.sku, p.unit
           FROM order_items oi JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = ?""", (order_id,)))
    invoice = ctx.conn.execute("SELECT * FROM invoices WHERE order_id = ?", (order_id,)).fetchone()
    return {"order": dict(order), "items": items, "invoice": dict(invoice) if invoice else None}


def apply_order_stock(conn, order_id, direction):
    """direction -1 ships goods out of stock, +1 returns them."""
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    for item in conn.execute(
            "SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall():
        log_move(conn, item["product_id"], "Sale Out" if direction < 0 else "Sale Return",
                 direction * item["qty"], order["order_no"],
                 "Order delivered" if direction < 0 else "Order reversed")
    conn.execute("UPDATE orders SET stock_applied = ? WHERE id = ?",
                 (1 if direction < 0 else 0, order_id))


@route("POST", r"/api/orders")
def create_order(ctx):
    ctx.require_user()
    body = ctx.body
    if not body.get("customer_id"):
        raise HttpError(400, "Select a customer for this order.")
    items = read_items(body)
    subtotal, discount, tax, total = totals_from(items, body)
    order_no = db.next_number(ctx.conn, "orders", "order_no", "ORD")
    cur = ctx.conn.execute(
        """INSERT INTO orders (order_no, customer_id, order_date, delivery_date, status,
                               delivery_status, tracking_note, notes, subtotal, discount, tax, total)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (order_no, int(body["customer_id"]), text(body.get("order_date"), today()) or today(),
         text(body.get("delivery_date")),
         text(body.get("status"), "Pending") or "Pending",
         text(body.get("delivery_status"), "Not Dispatched") or "Not Dispatched",
         text(body.get("tracking_note")), text(body.get("notes")),
         subtotal, discount, tax, total))
    order_id = cur.lastrowid
    for item in items:
        ctx.conn.execute(
            "INSERT INTO order_items (order_id, product_id, qty, price, line_total) VALUES (?,?,?,?,?)",
            (order_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
    if text(body.get("status")) == "Delivered":
        apply_order_stock(ctx.conn, order_id, -1)
    ctx.conn.commit()
    return {"id": order_id, "order_no": order_no}


@route("PUT", r"/api/orders/(\d+)")
def update_order(ctx, order_id):
    ctx.require_user()
    order = ctx.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    if ctx.conn.execute("SELECT 1 FROM invoices WHERE order_id = ?", (order_id,)).fetchone():
        raise HttpError(400, "This order is already invoiced and can no longer be edited.")
    body = ctx.body
    items = read_items(body)
    subtotal, discount, tax, total = totals_from(items, body)

    if order["stock_applied"]:
        apply_order_stock(ctx.conn, order_id, +1)
    ctx.conn.execute("DELETE FROM order_items WHERE order_id = ?", (order_id,))
    for item in items:
        ctx.conn.execute(
            "INSERT INTO order_items (order_id, product_id, qty, price, line_total) VALUES (?,?,?,?,?)",
            (order_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
    status = text(body.get("status"), order["status"]) or order["status"]
    ctx.conn.execute(
        """UPDATE orders SET customer_id=?, order_date=?, delivery_date=?, status=?,
                             delivery_status=?, tracking_note=?, notes=?, subtotal=?,
                             discount=?, tax=?, total=? WHERE id = ?""",
        (int(body["customer_id"]), text(body.get("order_date"), today()) or today(),
         text(body.get("delivery_date")), status,
         text(body.get("delivery_status"), order["delivery_status"]) or order["delivery_status"],
         text(body.get("tracking_note")), text(body.get("notes")),
         subtotal, discount, tax, total, order_id))
    if status == "Delivered":
        apply_order_stock(ctx.conn, order_id, -1)
    ctx.conn.commit()
    return {"ok": True}


@route("POST", r"/api/orders/(\d+)/status")
def set_order_status(ctx, order_id):
    ctx.require_user()
    order = ctx.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    status = text(ctx.body.get("status"), order["status"]) or order["status"]
    delivery = text(ctx.body.get("delivery_status"), order["delivery_status"]) or order["delivery_status"]
    if status not in ORDER_STATUSES:
        raise HttpError(400, f"Unknown order status: {status}")
    if delivery not in DELIVERY_STATUSES:
        raise HttpError(400, f"Unknown delivery status: {delivery}")
    if delivery == "Delivered" and status not in ("Delivered", "Cancelled"):
        status = "Delivered"

    ctx.conn.execute(
        "UPDATE orders SET status = ?, delivery_status = ?, tracking_note = ? WHERE id = ?",
        (status, delivery, text(ctx.body.get("tracking_note"), order["tracking_note"]), order_id))
    should_apply = status == "Delivered"
    if should_apply and not order["stock_applied"]:
        apply_order_stock(ctx.conn, order_id, -1)
        post_cogs(ctx.conn, order_id)
    elif not should_apply and order["stock_applied"]:
        apply_order_stock(ctx.conn, order_id, +1)
        unpost(ctx.conn, "COGS", order_id)
    ctx.conn.commit()
    return {"ok": True, "status": status, "delivery_status": delivery}


@route("DELETE", r"/api/orders/(\d+)")
def delete_order(ctx, order_id):
    ctx.require_user()
    order = ctx.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    invoice = ctx.conn.execute(
        "SELECT invoice_no FROM invoices WHERE order_id = ?", (order_id,)).fetchone()
    if invoice and not wants_cascade(ctx):
        blocked("This order has been invoiced.", {"invoice": invoice["invoice_no"]})
    purge_order(ctx.conn, order_id)
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Invoices
# --------------------------------------------------------------------------

@route("GET", r"/api/invoices")
def list_invoices(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    if ctx.query.get("status"):
        where.append("i.status = ?")
        params.append(ctx.query["status"])
    if ctx.query.get("customer_id"):
        where.append("i.customer_id = ?")
        params.append(ctx.query["customer_id"])
    if ctx.query.get("from"):
        where.append("i.invoice_date >= ?")
        params.append(ctx.query["from"])
    if ctx.query.get("to"):
        where.append("i.invoice_date <= ?")
        params.append(ctx.query["to"])
    if text(ctx.query.get("q")):
        where.append("(i.invoice_no LIKE ? OR c.name LIKE ?)")
        params += [f"%{ctx.query['q']}%"] * 2
    return rows(ctx.conn.execute(
        f"""SELECT i.*, c.name AS customer_name, o.order_no,
                   ROUND(i.total - i.paid, 2) AS balance
            FROM invoices i JOIN customers c ON c.id = i.customer_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE {' AND '.join(where)}
            ORDER BY i.invoice_date DESC, i.id DESC""", params))


@route("GET", r"/api/invoices/(\d+)")
def get_invoice(ctx, invoice_id):
    ctx.require_user()
    invoice = ctx.conn.execute(
        """SELECT i.*, c.name AS customer_name, c.contact AS customer_contact,
                  c.phone AS customer_phone, c.email AS customer_email,
                  c.address AS customer_address, c.city AS customer_city,
                  c.tax_id AS customer_tax_id, o.order_no
           FROM invoices i JOIN customers c ON c.id = i.customer_id
           LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ?""", (invoice_id,)).fetchone()
    if not invoice:
        raise HttpError(404, "Invoice not found.")
    items = rows(ctx.conn.execute(
        """SELECT ii.*, p.name AS product_name, p.sku, p.unit, p.pack_size
           FROM invoice_items ii JOIN products p ON p.id = ii.product_id
           WHERE ii.invoice_id = ?""", (invoice_id,)))
    company = dict(ctx.conn.execute("SELECT * FROM company WHERE id = 1").fetchone())
    return {"invoice": dict(invoice), "items": items, "company": company}


def invoice_status(total, paid):
    if paid <= 0:
        return "Unpaid"
    return "Paid" if paid + 0.005 >= total else "Partial"


@route("POST", r"/api/orders/(\d+)/invoice")
def invoice_from_order(ctx, order_id):
    """Convert an order into an invoice. Stock is handled by the order itself."""
    ctx.require_user()
    order = ctx.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    if order["status"] == "Cancelled":
        raise HttpError(400, "A cancelled order cannot be invoiced.")
    existing = ctx.conn.execute("SELECT id FROM invoices WHERE order_id = ?", (order_id,)).fetchone()
    if existing:
        return {"id": existing["id"], "existing": True}

    invoice_no = db.next_number(ctx.conn, "invoices", "invoice_no", "INV")
    cur = ctx.conn.execute(
        """INSERT INTO invoices (invoice_no, order_id, customer_id, invoice_date, due_date,
                                 subtotal, discount, tax, total, paid, status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (invoice_no, order_id, order["customer_id"], text(ctx.body.get("invoice_date"), today()) or today(),
         text(ctx.body.get("due_date")), order["subtotal"], order["discount"], order["tax"],
         order["total"], 0, "Unpaid", text(ctx.body.get("notes"), order["notes"])))
    invoice_id = cur.lastrowid
    for item in ctx.conn.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall():
        ctx.conn.execute(
            "INSERT INTO invoice_items (invoice_id, product_id, qty, price, line_total) VALUES (?,?,?,?,?)",
            (invoice_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
    post_invoice(ctx.conn, invoice_id)
    ctx.conn.commit()
    return {"id": invoice_id, "invoice_no": invoice_no}


@route("POST", r"/api/invoices")
def create_invoice(ctx):
    """Direct (counter) sale with no order behind it - deducts stock immediately."""
    ctx.require_user()
    body = ctx.body
    if not body.get("customer_id"):
        raise HttpError(400, "Select a customer for this invoice.")
    items = read_items(body)
    subtotal, discount, tax, total = totals_from(items, body)
    paid = num(body.get("paid"))
    invoice_no = db.next_number(ctx.conn, "invoices", "invoice_no", "INV")
    cur = ctx.conn.execute(
        """INSERT INTO invoices (invoice_no, order_id, customer_id, invoice_date, due_date,
                                 subtotal, discount, tax, total, paid, status, notes)
           VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?)""",
        (invoice_no, int(body["customer_id"]), text(body.get("invoice_date"), today()) or today(),
         text(body.get("due_date")), subtotal, discount, tax, total, paid,
         invoice_status(total, paid), text(body.get("notes"))))
    invoice_id = cur.lastrowid
    for item in items:
        ctx.conn.execute(
            "INSERT INTO invoice_items (invoice_id, product_id, qty, price, line_total) VALUES (?,?,?,?,?)",
            (invoice_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
        log_move(ctx.conn, item["product_id"], "Sale Out", -item["qty"], invoice_no, "Direct sale")
    post_invoice(ctx.conn, invoice_id)
    cost = round(sum(
        num(ctx.conn.execute("SELECT purchase_price p FROM products WHERE id = ?",
            (i["product_id"],)).fetchone()["p"]) * i["qty"] for i in items), 2)
    if cost > 0:
        post(ctx.conn, text(body.get("invoice_date"), today()) or today(),
             f"Cost of goods on {invoice_no}",
             [("5000", cost, 0, invoice_no), ("1200", 0, cost, invoice_no)],
             "COGS-Invoice", invoice_id)
    if paid > 0:
        post_receipt(ctx.conn, invoice_id, paid,
                     text(body.get("account"), "1000") or "1000",
                     text(body.get("invoice_date"), today()) or today())
    ctx.conn.commit()
    return {"id": invoice_id, "invoice_no": invoice_no}


@route("POST", r"/api/invoices/(\d+)/payment")
def record_payment(ctx, invoice_id):
    ctx.require_user()
    invoice = ctx.conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not invoice:
        raise HttpError(404, "Invoice not found.")
    amount = num(ctx.body.get("amount"))
    paid = round(min(invoice["paid"] + amount, invoice["total"]), 2) if amount > 0 else num(
        ctx.body.get("paid"), invoice["paid"])
    paid = max(0.0, min(paid, invoice["total"]))
    ctx.conn.execute("UPDATE invoices SET paid = ?, status = ? WHERE id = ?",
                     (paid, invoice_status(invoice["total"], paid), invoice_id))
    received = round(paid - invoice["paid"], 2)
    if received > 0:
        post_receipt(ctx.conn, invoice_id, received,
                     text(ctx.body.get("account"), "1000") or "1000",
                     text(ctx.body.get("date"), today()) or today())
    ctx.conn.commit()
    return {"paid": paid, "status": invoice_status(invoice["total"], paid)}


@route("DELETE", r"/api/invoices/(\d+)")
def delete_invoice(ctx, invoice_id):
    ctx.require_user()
    if not ctx.conn.execute("SELECT 1 FROM invoices WHERE id = ?", (invoice_id,)).fetchone():
        raise HttpError(404, "Invoice not found.")
    purge_invoice(ctx.conn, invoice_id)
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Purchases
# --------------------------------------------------------------------------

@route("GET", r"/api/purchases")
def list_purchases(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    if ctx.query.get("supplier_id"):
        where.append("p.supplier_id = ?")
        params.append(ctx.query["supplier_id"])
    if ctx.query.get("from"):
        where.append("p.purchase_date >= ?")
        params.append(ctx.query["from"])
    if ctx.query.get("to"):
        where.append("p.purchase_date <= ?")
        params.append(ctx.query["to"])
    if text(ctx.query.get("q")):
        where.append("(p.purchase_no LIKE ? OR p.bill_no LIKE ? OR s.name LIKE ?)")
        params += [f"%{ctx.query['q']}%"] * 3
    return rows(ctx.conn.execute(
        f"""SELECT p.*, s.name AS supplier_name, ROUND(p.total - p.paid, 2) AS balance
            FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
            WHERE {' AND '.join(where)}
            ORDER BY p.purchase_date DESC, p.id DESC""", params))


@route("GET", r"/api/purchases/(\d+)")
def get_purchase(ctx, purchase_id):
    ctx.require_user()
    purchase = ctx.conn.execute(
        """SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone,
                  s.address AS supplier_address, s.city AS supplier_city
           FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?""",
        (purchase_id,)).fetchone()
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    items = rows(ctx.conn.execute(
        """SELECT pi.*, pr.name AS product_name, pr.sku, pr.unit
           FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
           WHERE pi.purchase_id = ?""", (purchase_id,)))
    return {"purchase": dict(purchase), "items": items}


@route("POST", r"/api/purchases")
def create_purchase(ctx):
    ctx.require_user()
    body = ctx.body
    if not body.get("supplier_id"):
        raise HttpError(400, "Select a supplier for this purchase.")
    items = read_items(body)
    subtotal, discount, tax, total = totals_from(items, body)
    paid = num(body.get("paid"))
    status = text(body.get("status"), "Received") or "Received"
    purchase_no = db.next_number(ctx.conn, "purchases", "purchase_no", "PUR")
    cur = ctx.conn.execute(
        """INSERT INTO purchases (purchase_no, supplier_id, purchase_date, bill_no, subtotal,
                                  discount, tax, total, paid, status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (purchase_no, int(body["supplier_id"]),
         text(body.get("purchase_date"), today()) or today(), text(body.get("bill_no")),
         subtotal, discount, tax, total, paid, status, text(body.get("notes"))))
    purchase_id = cur.lastrowid
    for item in items:
        ctx.conn.execute(
            """INSERT INTO purchase_items (purchase_id, product_id, qty, price, line_total)
               VALUES (?,?,?,?,?)""",
            (purchase_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
    if status == "Received":
        apply_purchase_stock(ctx.conn, purchase_id, +1)
        if body.get("update_cost", True):
            for item in items:
                ctx.conn.execute("UPDATE products SET purchase_price = ? WHERE id = ?",
                                 (item["price"], item["product_id"]))
    post_purchase(ctx.conn, purchase_id)
    if paid > 0:
        post_supplier_payment(ctx.conn, purchase_id, paid,
                              text(body.get("account"), "1000") or "1000",
                              text(body.get("purchase_date"), today()) or today())
    ctx.conn.commit()
    return {"id": purchase_id, "purchase_no": purchase_no}


def apply_purchase_stock(conn, purchase_id, direction):
    purchase = conn.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    for item in conn.execute(
            "SELECT * FROM purchase_items WHERE purchase_id = ?", (purchase_id,)).fetchall():
        log_move(conn, item["product_id"], "Purchase In" if direction > 0 else "Purchase Return",
                 direction * item["qty"], purchase["purchase_no"],
                 "Goods received" if direction > 0 else "Purchase reversed")
    conn.execute("UPDATE purchases SET stock_applied = ? WHERE id = ?",
                 (1 if direction > 0 else 0, purchase_id))


@route("POST", r"/api/purchases/(\d+)/receive")
def receive_purchase(ctx, purchase_id):
    ctx.require_user()
    purchase = ctx.conn.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    if purchase["stock_applied"]:
        raise HttpError(400, "This purchase has already been received into stock.")
    apply_purchase_stock(ctx.conn, purchase_id, +1)
    ctx.conn.execute("UPDATE purchases SET status = 'Received' WHERE id = ?", (purchase_id,))
    ctx.conn.commit()
    return {"ok": True}


@route("POST", r"/api/purchases/(\d+)/payment")
def pay_purchase(ctx, purchase_id):
    ctx.require_user()
    purchase = ctx.conn.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    amount = num(ctx.body.get("amount"))
    paid = max(0.0, min(purchase["paid"] + amount, purchase["total"]))
    ctx.conn.execute("UPDATE purchases SET paid = ? WHERE id = ?", (round(paid, 2), purchase_id))
    sent = round(paid - purchase["paid"], 2)
    if sent > 0:
        post_supplier_payment(ctx.conn, purchase_id, sent,
                              text(ctx.body.get("account"), "1000") or "1000",
                              text(ctx.body.get("date"), today()) or today())
    ctx.conn.commit()
    return {"paid": round(paid, 2)}


@route("DELETE", r"/api/purchases/(\d+)")
def delete_purchase(ctx, purchase_id):
    ctx.require_user()
    if not ctx.conn.execute("SELECT 1 FROM purchases WHERE id = ?", (purchase_id,)).fetchone():
        raise HttpError(404, "Purchase not found.")
    purge_purchase(ctx.conn, purchase_id)
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Inventory
# --------------------------------------------------------------------------

@route("GET", r"/api/stock")
def stock_overview(ctx):
    ctx.require_user()
    return rows(ctx.conn.execute(
        """SELECT p.id, p.sku, p.name, p.category, p.unit, p.pack_size, p.stock,
                  p.reorder_level, p.purchase_price, p.sale_price,
                  ROUND(p.stock * p.purchase_price, 2) AS stock_value,
                  CASE WHEN p.stock <= 0 THEN 'Out of Stock'
                       WHEN p.stock <= p.reorder_level THEN 'Low Stock'
                       ELSE 'In Stock' END AS stock_state
           FROM products p WHERE p.active = 1 ORDER BY p.stock <= p.reorder_level DESC, p.name"""))


@route("POST", r"/api/stock/adjust")
def adjust_stock(ctx):
    ctx.require_user()
    product_id = int(ctx.body.get("product_id") or 0)
    if not product_id:
        raise HttpError(400, "Select a product to adjust.")
    qty = num(ctx.body.get("qty"))
    if qty == 0:
        raise HttpError(400, "Adjustment quantity cannot be zero.")
    log_move(ctx.conn, product_id, "Adjustment", qty, "MANUAL",
             text(ctx.body.get("note"), "Manual stock adjustment"))
    ctx.conn.commit()
    return {"ok": True}


@route("GET", r"/api/stock/moves")
def stock_moves(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    if ctx.query.get("product_id"):
        where.append("m.product_id = ?")
        params.append(ctx.query["product_id"])
    return rows(ctx.conn.execute(
        f"""SELECT m.*, p.name AS product_name, p.sku, p.unit
            FROM stock_moves m JOIN products p ON p.id = m.product_id
            WHERE {' AND '.join(where)} ORDER BY m.id DESC LIMIT 300""", params))


# --------------------------------------------------------------------------
# Dashboard & reports
# --------------------------------------------------------------------------

@route("GET", r"/api/dashboard")
def dashboard(ctx):
    ctx.require_user()
    conn = ctx.conn
    month_start = datetime.now().strftime("%Y-%m-01")
    scalar = lambda sql, p=(): conn.execute(sql, p).fetchone()[0] or 0

    recent_sales = rows(conn.execute(
        """SELECT invoice_date d, ROUND(SUM(total), 2) amount FROM invoices
           WHERE invoice_date >= date('now', '-13 days') GROUP BY invoice_date ORDER BY invoice_date"""))
    return {
        "sales_month": round(scalar(
            "SELECT SUM(total) FROM invoices WHERE invoice_date >= ?", (month_start,)), 2),
        "purchases_month": round(scalar(
            "SELECT SUM(total) FROM purchases WHERE purchase_date >= ?", (month_start,)), 2),
        "receivables": round(scalar("SELECT SUM(total - paid) FROM invoices WHERE total > paid"), 2),
        "payables": round(scalar("SELECT SUM(total - paid) FROM purchases WHERE total > paid"), 2),
        "stock_value": round(scalar(
            "SELECT SUM(stock * purchase_price) FROM products WHERE active = 1"), 2),
        "open_orders": scalar(
            "SELECT COUNT(*) FROM orders WHERE status IN ('Pending','Confirmed')"),
        "pending_deliveries": scalar(
            """SELECT COUNT(*) FROM orders WHERE status <> 'Cancelled'
               AND delivery_status NOT IN ('Delivered','Returned')"""),
        "low_stock_count": scalar(
            "SELECT COUNT(*) FROM products WHERE active = 1 AND stock <= reorder_level"),
        "customers": scalar("SELECT COUNT(*) FROM customers WHERE active = 1"),
        "suppliers": scalar("SELECT COUNT(*) FROM suppliers WHERE active = 1"),
        "products": scalar("SELECT COUNT(*) FROM products WHERE active = 1"),
        "sales_trend": recent_sales,
        "recent_orders": rows(conn.execute(
            """SELECT o.id, o.order_no, o.order_date, o.status, o.delivery_status, o.total,
                      c.name AS customer_name
               FROM orders o JOIN customers c ON c.id = o.customer_id
               ORDER BY o.id DESC LIMIT 8""")),
        "low_stock": rows(conn.execute(
            """SELECT id, sku, name, stock, reorder_level, unit FROM products
               WHERE active = 1 AND stock <= reorder_level ORDER BY stock LIMIT 8""")),
    }


@route("GET", r"/api/reports/sales")
def report_sales(ctx):
    ctx.require_user()
    start = text(ctx.query.get("from"), datetime.now().strftime("%Y-%m-01"))
    end = text(ctx.query.get("to"), today())
    conn = ctx.conn
    summary = dict(conn.execute(
        """SELECT COUNT(*) invoices, ROUND(COALESCE(SUM(total),0),2) total,
                  ROUND(COALESCE(SUM(paid),0),2) paid,
                  ROUND(COALESCE(SUM(total - paid),0),2) outstanding,
                  ROUND(COALESCE(SUM(tax),0),2) tax,
                  ROUND(COALESCE(SUM(discount),0),2) discount
           FROM invoices WHERE invoice_date BETWEEN ? AND ?""", (start, end)).fetchone())
    return {
        "from": start, "to": end, "summary": summary,
        "by_day": rows(conn.execute(
            """SELECT invoice_date d, COUNT(*) n, ROUND(SUM(total),2) amount FROM invoices
               WHERE invoice_date BETWEEN ? AND ? GROUP BY invoice_date ORDER BY invoice_date""",
            (start, end))),
        "by_customer": rows(conn.execute(
            """SELECT c.name, COUNT(*) n, ROUND(SUM(i.total),2) amount,
                      ROUND(SUM(i.total - i.paid),2) outstanding
               FROM invoices i JOIN customers c ON c.id = i.customer_id
               WHERE i.invoice_date BETWEEN ? AND ?
               GROUP BY c.id ORDER BY amount DESC""", (start, end))),
        "by_product": rows(conn.execute(
            """SELECT p.sku, p.name, p.unit, ROUND(SUM(ii.qty),2) qty,
                      ROUND(SUM(ii.line_total),2) amount
               FROM invoice_items ii
               JOIN invoices i ON i.id = ii.invoice_id
               JOIN products p ON p.id = ii.product_id
               WHERE i.invoice_date BETWEEN ? AND ?
               GROUP BY p.id ORDER BY amount DESC""", (start, end))),
    }


@route("GET", r"/api/reports/purchases")
def report_purchases(ctx):
    ctx.require_user()
    start = text(ctx.query.get("from"), datetime.now().strftime("%Y-%m-01"))
    end = text(ctx.query.get("to"), today())
    conn = ctx.conn
    summary = dict(conn.execute(
        """SELECT COUNT(*) purchases, ROUND(COALESCE(SUM(total),0),2) total,
                  ROUND(COALESCE(SUM(paid),0),2) paid,
                  ROUND(COALESCE(SUM(total - paid),0),2) outstanding
           FROM purchases WHERE purchase_date BETWEEN ? AND ?""", (start, end)).fetchone())
    return {
        "from": start, "to": end, "summary": summary,
        "by_supplier": rows(conn.execute(
            """SELECT s.name, COUNT(*) n, ROUND(SUM(p.total),2) amount,
                      ROUND(SUM(p.total - p.paid),2) outstanding
               FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
               WHERE p.purchase_date BETWEEN ? AND ?
               GROUP BY s.id ORDER BY amount DESC""", (start, end))),
        "by_product": rows(conn.execute(
            """SELECT pr.sku, pr.name, pr.unit, ROUND(SUM(pi.qty),2) qty,
                      ROUND(SUM(pi.line_total),2) amount
               FROM purchase_items pi
               JOIN purchases p ON p.id = pi.purchase_id
               JOIN products pr ON pr.id = pi.product_id
               WHERE p.purchase_date BETWEEN ? AND ?
               GROUP BY pr.id ORDER BY amount DESC""", (start, end))),
    }


@route("GET", r"/api/reports/inventory")
def report_inventory(ctx):
    ctx.require_user()
    conn = ctx.conn
    return {
        "summary": dict(conn.execute(
            """SELECT COUNT(*) products,
                      ROUND(COALESCE(SUM(stock * purchase_price),0),2) cost_value,
                      ROUND(COALESCE(SUM(stock * sale_price),0),2) retail_value,
                      SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) out_of_stock,
                      SUM(CASE WHEN stock > 0 AND stock <= reorder_level THEN 1 ELSE 0 END) low_stock
               FROM products WHERE active = 1""").fetchone()),
        "by_category": rows(conn.execute(
            """SELECT COALESCE(NULLIF(category,''),'Uncategorised') category, COUNT(*) n,
                      ROUND(SUM(stock),2) qty, ROUND(SUM(stock * purchase_price),2) cost_value
               FROM products WHERE active = 1 GROUP BY category ORDER BY cost_value DESC""")),
        "items": stock_overview(ctx),
    }



# --------------------------------------------------------------------------
# Bookkeeping
#
# Every financial event posts a balanced journal entry. The statements are read
# back from those entries, never recomputed from documents, so what the reports
# show is exactly what the ledger holds. post() refuses to write anything that
# does not balance - a ledger that can drift is worse than no ledger.
# --------------------------------------------------------------------------

def account_id(conn, code):
    row = conn.execute("SELECT id FROM accounts WHERE code = ?", (code,)).fetchone()
    return row["id"] if row else None


def post(conn, entry_date, memo, lines, source="Manual", source_id=None):
    """Write one balanced entry. lines: [(account code or id, debit, credit, memo)]"""
    prepared = []
    for account, debit, credit, note in lines:
        acc = account if isinstance(account, int) else account_id(conn, account)
        if acc is None:
            raise HttpError(400, f"No such account: {account}")
        debit, credit = round(float(debit or 0), 2), round(float(credit or 0), 2)
        if debit and credit:
            raise HttpError(400, "A line is either a debit or a credit, not both.")
        if debit or credit:
            prepared.append((acc, debit, credit, note))
    if not prepared:
        return None

    debits = round(sum(l[1] for l in prepared), 2)
    credits = round(sum(l[2] for l in prepared), 2)
    if abs(debits - credits) > 0.005:
        raise HttpError(400, f"Entry does not balance: debits {debits} vs credits {credits}.")

    number = db.next_number(conn, "journal_entries", "entry_no", "JV")
    cur = conn.execute(
        """INSERT INTO journal_entries (entry_no, entry_date, memo, source, source_id)
           VALUES (?,?,?,?,?)""", (number, entry_date, memo, source, source_id))
    entry_id = cur.lastrowid
    for acc, debit, credit, note in prepared:
        conn.execute(
            """INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo)
               VALUES (?,?,?,?,?)""", (entry_id, acc, debit, credit, note))
    return entry_id


def unpost(conn, source, source_id):
    """Remove the entries a document produced, used when it is deleted."""
    for row in conn.execute(
            "SELECT id FROM journal_entries WHERE source = ? AND source_id = ?",
            (source, source_id)).fetchall():
        conn.execute("DELETE FROM journal_entries WHERE id = ?", (row["id"],))


def post_invoice(conn, invoice_id):
    """Sale on credit: the customer owes us, income is earned, tax is collected."""
    inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not inv:
        return
    unpost(conn, "Invoice", invoice_id)
    memo = f"Invoice {inv['invoice_no']}"
    lines = [("1100", inv["total"], 0, memo),
             ("4000", 0, inv["subtotal"], memo)]
    if inv["discount"]:
        lines.append(("4100", inv["discount"], 0, "Discount given"))
    if inv["tax"]:
        lines.append(("2100", 0, inv["tax"], "Tax on sale"))
    post(conn, inv["invoice_date"], memo, lines, "Invoice", invoice_id)


def post_cogs(conn, order_id):
    """Goods leaving the shelf become a cost, at what they cost us to buy."""
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return
    unpost(conn, "COGS", order_id)
    cost = conn.execute(
        """SELECT COALESCE(SUM(oi.qty * p.purchase_price), 0) c
           FROM order_items oi JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = ?""", (order_id,)).fetchone()["c"]
    cost = round(cost, 2)
    if cost <= 0:
        return
    memo = f"Cost of goods on {order['order_no']}"
    post(conn, order["order_date"], memo,
         [("5000", cost, 0, memo), ("1200", 0, cost, memo)], "COGS", order_id)


def post_purchase(conn, purchase_id):
    """Goods bought on credit: stock rises, we owe the supplier."""
    pur = conn.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not pur:
        return
    unpost(conn, "Purchase", purchase_id)
    memo = f"Purchase {pur['purchase_no']}"
    goods = round(pur["subtotal"] - pur["discount"], 2)
    lines = [("1200", goods, 0, memo), ("2000", 0, pur["total"], memo)]
    if pur["tax"]:
        lines.append(("2100", pur["tax"], 0, "Tax on purchase"))
    post(conn, pur["purchase_date"], memo, lines, "Purchase", purchase_id)


def post_receipt(conn, invoice_id, amount, account_code, when):
    inv = conn.execute("SELECT invoice_no FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    memo = f"Payment received on {inv['invoice_no']}" if inv else "Payment received"
    post(conn, when, memo,
         [(account_code, amount, 0, memo), ("1100", 0, amount, memo)], "Receipt", invoice_id)


def post_supplier_payment(conn, purchase_id, amount, account_code, when):
    pur = conn.execute("SELECT purchase_no FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    memo = f"Paid supplier for {pur['purchase_no']}" if pur else "Supplier payment"
    post(conn, when, memo,
         [("2000", amount, 0, memo), (account_code, 0, amount, memo)], "Payment", purchase_id)


# --------------------------------------------------------------------------
# Deletion
#
# Anything can be removed, but never silently: a delete that would take other
# records with it is refused until the caller passes cascade=1, and the refusal
# says exactly what would go. Stock is unwound first so inventory stays true.
# --------------------------------------------------------------------------

def wants_cascade(ctx):
    return str(ctx.query.get("cascade", "")).lower() in ("1", "true", "yes")


def blocked(message, impact):
    raise HttpError(409, message + " |IMPACT| " + json.dumps(impact))


def purge_order(conn, order_id):
    """Remove an order, its invoice, and give back any stock it moved."""
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return
    if order["stock_applied"]:
        apply_order_stock(conn, order_id, +1)
    for invoice in conn.execute(
            "SELECT id FROM invoices WHERE order_id = ?", (order_id,)).fetchall():
        unpost(conn, "Invoice", invoice["id"])
        unpost(conn, "Receipt", invoice["id"])
        conn.execute("DELETE FROM invoices WHERE id = ?", (invoice["id"],))
    unpost(conn, "COGS", order_id)
    conn.execute("DELETE FROM orders WHERE id = ?", (order_id,))


def purge_invoice(conn, invoice_id):
    invoice = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not invoice:
        return
    if invoice["order_id"] is None:      # a direct sale moved stock on its own
        for item in conn.execute(
                "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall():
            log_move(conn, item["product_id"], "Sale Return", item["qty"],
                     invoice["invoice_no"], "Invoice deleted")
    for kind in ("Invoice", "Receipt", "COGS-Invoice"):
        unpost(conn, kind, invoice_id)
    conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))


def purge_purchase(conn, purchase_id):
    purchase = conn.execute(
        "SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not purchase:
        return
    if purchase["stock_applied"]:
        apply_purchase_stock(conn, purchase_id, -1)
    unpost(conn, "Purchase", purchase_id)
    unpost(conn, "Payment", purchase_id)
    conn.execute("DELETE FROM purchases WHERE id = ?", (purchase_id,))


# --------------------------------------------------------------------------
# Field entries - offline capture and sync
# --------------------------------------------------------------------------

@route("GET", r"/api/field/bootstrap")
def field_bootstrap(ctx):
    """Everything the phone caches so the form still works with no signal."""
    ctx.require_field_access()
    return {
        "company": company_name(ctx.conn),
        "products": rows(ctx.conn.execute(
            """SELECT sku, name, unit, sale_price, purchase_price FROM products
               WHERE active = 1 ORDER BY name""")),
        "customers": [r["name"] for r in ctx.conn.execute(
            "SELECT name FROM customers WHERE active = 1 ORDER BY name").fetchall()],
        "suppliers": [r["name"] for r in ctx.conn.execute(
            "SELECT name FROM suppliers WHERE active = 1 ORDER BY name").fetchall()],
        "server_time": now_iso(),
    }


@route("POST", r"/api/field/sync")
def field_sync(ctx):
    """Accept a batch queued on a phone. Safe to call repeatedly: an entry
    already stored is acknowledged rather than inserted again."""
    ctx.require_field_access()
    entries = ctx.body.get("entries")
    if not isinstance(entries, list):
        raise HttpError(400, "Expected a list of entries.")
    device = text(ctx.body.get("device"))[:64]

    accepted, duplicates = [], []
    for raw in entries[:200]:
        client_id = text(raw.get("client_id"))[:64]
        if not client_id:
            continue
        seen = ctx.conn.execute(
            "SELECT id FROM field_entries WHERE client_id = ?", (client_id,)).fetchone()
        if seen:
            duplicates.append(client_id)
            continue
        items = raw.get("items") or []
        total = round(sum(num(i.get("qty")) * num(i.get("price")) for i in items), 2)
        ctx.conn.execute(
            """INSERT INTO field_entries (client_id, kind, party_name, phone, city,
                                          entry_date, notes, items, total, device,
                                          captured_at, status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?, 'Pending')""",
            (client_id,
             "Purchase" if text(raw.get("kind")) == "Purchase" else "Booking",
             text(raw.get("party_name"))[:200], text(raw.get("phone"))[:40],
             text(raw.get("city"))[:80], text(raw.get("entry_date"), today()) or today(),
             text(raw.get("notes"))[:1000], json.dumps(items), total, device,
             text(raw.get("captured_at"))))
        accepted.append(client_id)
    ctx.conn.commit()
    return {"accepted": accepted, "duplicates": duplicates,
            "stored": len(accepted), "server_time": now_iso()}


@route("GET", r"/api/field/entries")
def list_field_entries(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    if ctx.query.get("status"):
        where.append("status = ?")
        params.append(ctx.query["status"])
    entries = rows(ctx.conn.execute(
        f"""SELECT * FROM field_entries WHERE {' AND '.join(where)}
            ORDER BY id DESC LIMIT 300""", params))
    for entry in entries:
        try:
            entry["items"] = json.loads(entry["items"] or "[]")
        except ValueError:
            entry["items"] = []
    return entries


@route("POST", r"/api/field/entries/(\d+)/convert")
def convert_field_entry(ctx, entry_id):
    """Turn a reviewed field entry into a real order or purchase."""
    ctx.require_user()
    entry = ctx.conn.execute(
        "SELECT * FROM field_entries WHERE id = ?", (entry_id,)).fetchone()
    if not entry:
        raise HttpError(404, "Entry not found.")
    if entry["status"] != "Pending":
        raise HttpError(400, f"This entry is already {entry['status'].lower()}.")

    items = []
    for line in json.loads(entry["items"] or "[]"):
        product = ctx.conn.execute(
            "SELECT id FROM products WHERE sku = ?", (text(line.get("sku")),)).fetchone()
        if not product:
            raise HttpError(400, f"No product matches code {line.get('sku')!r}. "
                                 "Add it first, then convert.")
        qty, price = num(line.get("qty")), num(line.get("price"))
        items.append({"product_id": product["id"], "qty": qty, "price": price,
                      "line_total": round(qty * price, 2)})
    if not items:
        raise HttpError(400, "This entry has no items to convert.")

    party_table = "suppliers" if entry["kind"] == "Purchase" else "customers"
    party = ctx.conn.execute(
        f"SELECT id FROM {party_table} WHERE name = ?", (entry["party_name"],)).fetchone()
    if party:
        party_id = party["id"]
    else:
        cur = ctx.conn.execute(
            f"INSERT INTO {party_table} (name, phone, city) VALUES (?,?,?)",
            (entry["party_name"] or "Unnamed", entry["phone"], entry["city"]))
        party_id = cur.lastrowid

    subtotal = round(sum(i["line_total"] for i in items), 2)
    note = f"From field entry {entry['client_id'][:8]}. {entry['notes']}".strip()

    if entry["kind"] == "Purchase":
        number = db.next_number(ctx.conn, "purchases", "purchase_no", "PUR")
        cur = ctx.conn.execute(
            """INSERT INTO purchases (purchase_no, supplier_id, purchase_date, subtotal,
                                      total, status, notes)
               VALUES (?,?,?,?,?, 'Ordered', ?)""",
            (number, party_id, entry["entry_date"], subtotal, subtotal, note))
        new_id = cur.lastrowid
        for item in items:
            ctx.conn.execute(
                """INSERT INTO purchase_items (purchase_id, product_id, qty, price, line_total)
                   VALUES (?,?,?,?,?)""",
                (new_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
        target = "purchases"
    else:
        number = db.next_number(ctx.conn, "orders", "order_no", "ORD")
        cur = ctx.conn.execute(
            """INSERT INTO orders (order_no, customer_id, order_date, status,
                                   delivery_status, notes, subtotal, total)
               VALUES (?,?,?, 'Pending', 'Not Dispatched', ?,?,?)""",
            (number, party_id, entry["entry_date"], note, subtotal, subtotal))
        new_id = cur.lastrowid
        for item in items:
            ctx.conn.execute(
                """INSERT INTO order_items (order_id, product_id, qty, price, line_total)
                   VALUES (?,?,?,?,?)""",
                (new_id, item["product_id"], item["qty"], item["price"], item["line_total"]))
        target = "orders"

    ctx.conn.execute(
        "UPDATE field_entries SET status = 'Converted', linked_id = ?, linked_no = ? WHERE id = ?",
        (new_id, number, entry_id))
    ctx.conn.commit()
    return {"ok": True, "target": target, "id": new_id, "number": number}


@route("POST", r"/api/field/entries/(\d+)/reject")
def reject_field_entry(ctx, entry_id):
    ctx.require_user()
    ctx.conn.execute(
        "UPDATE field_entries SET status = 'Rejected' WHERE id = ? AND status = 'Pending'",
        (entry_id,))
    ctx.conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Accounting endpoints
# --------------------------------------------------------------------------

NORMAL_DEBIT = ("Asset", "Expense")     # these grow with debits; the rest with credits


@route("GET", r"/api/accounts")
def list_accounts(ctx):
    ctx.require_user()
    return rows(ctx.conn.execute(
        """SELECT a.*,
                  ROUND(COALESCE((SELECT SUM(l.debit) FROM journal_lines l
                                  WHERE l.account_id = a.id), 0), 2) AS debits,
                  ROUND(COALESCE((SELECT SUM(l.credit) FROM journal_lines l
                                  WHERE l.account_id = a.id), 0), 2) AS credits
           FROM accounts a ORDER BY a.code"""))


@route("POST", r"/api/accounts")
def create_account(ctx):
    ctx.require_user()
    code, name = text(ctx.body.get("code")), text(ctx.body.get("name"))
    kind = text(ctx.body.get("type"))
    if not code or not name:
        raise HttpError(400, "Account code and name are required.")
    if kind not in ("Asset", "Liability", "Equity", "Income", "Expense"):
        raise HttpError(400, "Type must be Asset, Liability, Equity, Income or Expense.")
    if ctx.conn.execute("SELECT 1 FROM accounts WHERE code = ?", (code,)).fetchone():
        raise HttpError(400, f"Account {code} already exists.")
    cur = ctx.conn.execute(
        """INSERT INTO accounts (code, name, type, subtype, is_cash) VALUES (?,?,?,?,?)""",
        (code, name, kind, text(ctx.body.get("subtype")),
         1 if ctx.body.get("is_cash") else 0))
    ctx.conn.commit()
    return {"id": cur.lastrowid}


@route("DELETE", r"/api/accounts/(\d+)")
def delete_account(ctx, account_id):
    ctx.require_user()
    account = ctx.conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not account:
        raise HttpError(404, "Account not found.")
    if account["system"]:
        raise HttpError(400, "This account is used by the system and cannot be removed.")
    used = ctx.conn.execute("SELECT COUNT(*) c FROM journal_lines WHERE account_id = ?",
                            (account_id,)).fetchone()["c"]
    if used and not wants_cascade(ctx):
        blocked("This account has postings against it.", {"journal_lines": used})
    ctx.conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    ctx.conn.commit()
    return {"ok": True}


@route("GET", r"/api/journal")
def list_journal(ctx):
    ctx.require_user()
    where, params = ["1=1"], []
    if ctx.query.get("from"):
        where.append("e.entry_date >= ?")
        params.append(ctx.query["from"])
    if ctx.query.get("to"):
        where.append("e.entry_date <= ?")
        params.append(ctx.query["to"])
    if ctx.query.get("account_id"):
        where.append("EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id "
                     "AND x.account_id = ?)")
        params.append(ctx.query["account_id"])
    entries = rows(ctx.conn.execute(
        f"""SELECT e.* FROM journal_entries e WHERE {' AND '.join(where)}
            ORDER BY e.entry_date DESC, e.id DESC LIMIT 300""", params))
    for entry in entries:
        entry["lines"] = rows(ctx.conn.execute(
            """SELECT l.*, a.code, a.name FROM journal_lines l
               JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?
               ORDER BY l.debit DESC""", (entry["id"],)))
    return entries


@route("POST", r"/api/journal")
def create_journal(ctx):
    """A manual entry, for anything the documents do not cover."""
    ctx.require_user()
    lines = []
    for raw in ctx.body.get("lines") or []:
        if not raw.get("account_id"):
            continue
        lines.append((int(raw["account_id"]), num(raw.get("debit")),
                      num(raw.get("credit")), text(raw.get("memo"))))
    if len(lines) < 2:
        raise HttpError(400, "An entry needs at least two lines.")
    entry_id = post(ctx.conn, text(ctx.body.get("entry_date"), today()) or today(),
                    text(ctx.body.get("memo")), lines, "Manual")
    ctx.conn.commit()
    return {"id": entry_id}


@route("DELETE", r"/api/journal/(\d+)")
def delete_journal(ctx, entry_id):
    ctx.require_user()
    entry = ctx.conn.execute(
        "SELECT source FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
    if not entry:
        raise HttpError(404, "Entry not found.")
    if entry["source"] != "Manual":
        raise HttpError(400, "This entry belongs to a document. Delete the document instead.")
    ctx.conn.execute("DELETE FROM journal_entries WHERE id = ?", (entry_id,))
    ctx.conn.commit()
    return {"ok": True}


@route("POST", r"/api/expenses")
def record_expense(ctx):
    """Money out that is not a supplier bill - rent, wages, fuel."""
    ctx.require_user()
    amount = num(ctx.body.get("amount"))
    if amount <= 0:
        raise HttpError(400, "Enter an amount greater than zero.")
    expense = text(ctx.body.get("expense_account"), "6900") or "6900"
    paid_from = text(ctx.body.get("paid_from"), "1000") or "1000"
    memo = text(ctx.body.get("memo"), "Expense") or "Expense"
    entry_id = post(ctx.conn, text(ctx.body.get("entry_date"), today()) or today(), memo,
                    [(expense, amount, 0, memo), (paid_from, 0, amount, memo)], "Expense")
    ctx.conn.commit()
    return {"id": entry_id}


def balances(conn, start=None, end=None):
    where, params = ["1=1"], []
    if start:
        where.append("e.entry_date >= ?")
        params.append(start)
    if end:
        where.append("e.entry_date <= ?")
        params.append(end)
    return rows(conn.execute(
        f"""SELECT a.id, a.code, a.name, a.type, a.subtype, a.is_cash,
                   ROUND(COALESCE(SUM(l.debit), 0), 2)  AS debit,
                   ROUND(COALESCE(SUM(l.credit), 0), 2) AS credit
            FROM accounts a
            LEFT JOIN journal_lines l ON l.account_id = a.id
            LEFT JOIN journal_entries e ON e.id = l.entry_id AND {' AND '.join(where)}
            GROUP BY a.id ORDER BY a.code""", params))


def signed(account):
    """Balance in the direction the account naturally runs."""
    diff = account["debit"] - account["credit"]
    return round(diff if account["type"] in NORMAL_DEBIT else -diff, 2)


@route("GET", r"/api/reports/trial-balance")
def trial_balance(ctx):
    ctx.require_user()
    end = text(ctx.query.get("to"), today())
    accounts = [a for a in balances(ctx.conn, None, end) if a["debit"] or a["credit"]]
    for a in accounts:
        net = round(a["debit"] - a["credit"], 2)
        a["debit_balance"] = net if net > 0 else 0
        a["credit_balance"] = -net if net < 0 else 0
    return {"to": end, "accounts": accounts,
            "total_debit": round(sum(a["debit_balance"] for a in accounts), 2),
            "total_credit": round(sum(a["credit_balance"] for a in accounts), 2)}


@route("GET", r"/api/reports/profit-loss")
def profit_loss(ctx):
    ctx.require_user()
    start = text(ctx.query.get("from"), datetime.now().strftime("%Y-%m-01"))
    end = text(ctx.query.get("to"), today())
    accounts = balances(ctx.conn, start, end)
    income = [dict(a, amount=signed(a)) for a in accounts
              if a["type"] == "Income" and (a["debit"] or a["credit"])]
    expense = [dict(a, amount=signed(a)) for a in accounts
               if a["type"] == "Expense" and (a["debit"] or a["credit"])]
    total_income = round(sum(a["amount"] for a in income), 2)
    cost_of_sales = round(sum(a["amount"] for a in expense
                              if a["subtype"] == "Cost of Sales"), 2)
    operating = round(sum(a["amount"] for a in expense
                          if a["subtype"] != "Cost of Sales"), 2)
    return {"from": start, "to": end, "income": income, "expense": expense,
            "total_income": total_income, "cost_of_sales": cost_of_sales,
            "gross_profit": round(total_income - cost_of_sales, 2),
            "operating_expenses": operating,
            "net_profit": round(total_income - cost_of_sales - operating, 2)}


@route("GET", r"/api/reports/balance-sheet")
def balance_sheet(ctx):
    ctx.require_user()
    end = text(ctx.query.get("to"), today())
    accounts = balances(ctx.conn, None, end)
    pick = lambda kind: [dict(a, amount=signed(a)) for a in accounts
                         if a["type"] == kind and (a["debit"] or a["credit"])]
    assets, liabilities, equity = pick("Asset"), pick("Liability"), pick("Equity")
    # Profit for the period has not been closed to equity, so show it there.
    earned = round(sum(signed(a) for a in accounts if a["type"] == "Income")
                   - sum(signed(a) for a in accounts if a["type"] == "Expense"), 2)
    total_assets = round(sum(a["amount"] for a in assets), 2)
    total_liabilities = round(sum(a["amount"] for a in liabilities), 2)
    total_equity = round(sum(a["amount"] for a in equity) + earned, 2)
    return {"to": end, "assets": assets, "liabilities": liabilities, "equity": equity,
            "retained_this_period": earned, "total_assets": total_assets,
            "total_liabilities": total_liabilities, "total_equity": total_equity,
            "balances": abs(total_assets - (total_liabilities + total_equity)) < 0.05}


@route("GET", r"/api/reports/ledger/(\d+)")
def account_ledger(ctx, account_id):
    ctx.require_user()
    account = ctx.conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not account:
        raise HttpError(404, "Account not found.")
    lines = rows(ctx.conn.execute(
        """SELECT e.entry_no, e.entry_date, e.memo, e.source, l.debit, l.credit, l.memo AS line_memo
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE l.account_id = ? ORDER BY e.entry_date, e.id""", (account_id,)))
    running = 0
    for line in lines:
        delta = line["debit"] - line["credit"]
        running = round(running + (delta if account["type"] in NORMAL_DEBIT else -delta), 2)
        line["balance"] = running
    return {"account": dict(account), "lines": lines, "closing": running}


@route("GET", r"/api/reports/aging")
def aging(ctx):
    """Who owes us, and whom we owe, sorted by how overdue it is."""
    ctx.require_user()
    payable = ctx.query.get("kind") == "payable"
    as_at = text(ctx.query.get("to"), today())
    if payable:
        sql = """SELECT p.purchase_no AS ref, p.purchase_date AS doc_date, s.name AS party,
                        ROUND(p.total - p.paid, 2) AS outstanding
                 FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
                 WHERE p.total - p.paid > 0.005 AND p.purchase_date <= ?"""
    else:
        sql = """SELECT i.invoice_no AS ref, i.invoice_date AS doc_date, c.name AS party,
                        ROUND(i.total - i.paid, 2) AS outstanding
                 FROM invoices i JOIN customers c ON c.id = i.customer_id
                 WHERE i.total - i.paid > 0.005 AND i.invoice_date <= ?"""
    docs = rows(ctx.conn.execute(sql + " ORDER BY doc_date", (as_at,)))

    cutoff = datetime.strptime(as_at, "%Y-%m-%d")
    buckets = {"current": 0.0, "d30": 0.0, "d60": 0.0, "d90": 0.0, "older": 0.0}
    parties = {}
    for doc in docs:
        try:
            age = (cutoff - datetime.strptime(doc["doc_date"], "%Y-%m-%d")).days
        except ValueError:
            age = 0
        band = ("current" if age <= 0 else "d30" if age <= 30 else
                "d60" if age <= 60 else "d90" if age <= 90 else "older")
        doc["days"] = age
        doc["band"] = band
        buckets[band] = round(buckets[band] + doc["outstanding"], 2)
        row = parties.setdefault(doc["party"], dict(party=doc["party"], total=0.0,
                                                    **{k: 0.0 for k in buckets}))
        row[band] = round(row[band] + doc["outstanding"], 2)
        row["total"] = round(row["total"] + doc["outstanding"], 2)
    return {"kind": "payable" if payable else "receivable", "to": as_at,
            "documents": docs, "by_party": sorted(parties.values(),
                                                  key=lambda r: -r["total"]),
            "buckets": buckets,
            "total": round(sum(buckets.values()), 2)}


@route("GET", r"/api/reports/reconcile/(\d+)")
def reconciliation(ctx, account_id):
    """Tick postings off against a bank statement."""
    ctx.require_user()
    account = ctx.conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not account:
        raise HttpError(404, "Account not found.")
    as_at = text(ctx.query.get("to"), today())
    lines = rows(ctx.conn.execute(
        """SELECT l.id, l.debit, l.credit, l.cleared, l.cleared_date, l.memo,
                  e.entry_no, e.entry_date, e.memo AS entry_memo, e.source
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE l.account_id = ? AND e.entry_date <= ?
           ORDER BY e.entry_date, e.id""", (account_id, as_at)))
    ledger = round(sum(l["debit"] - l["credit"] for l in lines), 2)
    cleared = round(sum(l["debit"] - l["credit"] for l in lines if l["cleared"]), 2)
    return {"account": dict(account), "to": as_at, "lines": lines,
            "ledger_balance": ledger, "cleared_balance": cleared,
            "uncleared": round(ledger - cleared, 2)}


@route("POST", r"/api/journal/lines/(\d+)/clear")
def clear_line(ctx, line_id):
    ctx.require_user()
    cleared = 1 if ctx.body.get("cleared", True) else 0
    ctx.conn.execute("UPDATE journal_lines SET cleared = ?, cleared_date = ? WHERE id = ?",
                     (cleared, today() if cleared else "", line_id))
    ctx.conn.commit()
    return {"ok": True, "cleared": bool(cleared)}


@route("GET", r"/api/accounting/closings")
def list_closings(ctx):
    ctx.require_user()
    return rows(ctx.conn.execute(
        """SELECT c.*, e.entry_no FROM closings c
           LEFT JOIN journal_entries e ON e.id = c.entry_id
           ORDER BY c.closed_to DESC"""))


@route("POST", r"/api/accounting/close")
def close_year(ctx):
    """Sweep income and expense into retained earnings, so the new year starts
    from zero and the balance sheet carries the profit."""
    ctx.require_admin()
    to_date = text(ctx.body.get("to"), today()) or today()
    if text(ctx.body.get("confirm")) != "CLOSE":
        raise HttpError(400, "Type CLOSE to confirm.")
    last = ctx.conn.execute(
        "SELECT closed_to FROM closings ORDER BY closed_to DESC LIMIT 1").fetchone()
    start = last["closed_to"] if last else None
    if start and to_date <= start:
        raise HttpError(400, f"The books are already closed to {start}.")

    accounts = balances(ctx.conn, start, to_date)
    lines, profit = [], 0.0
    for a in accounts:
        net = round(a["debit"] - a["credit"], 2)
        if a["type"] not in ("Income", "Expense") or not net:
            continue
        # close the account by posting the opposite of its balance
        lines.append((a["id"], -net if net < 0 else 0, net if net > 0 else 0,
                      "Year-end close"))
        profit = round(profit - net, 2)      # income is credit-negative, expense positive
    if not lines:
        raise HttpError(400, "There is nothing to close for this period.")
    lines.append((account_id(ctx.conn, "3900"),
                  0 if profit >= 0 else -profit, profit if profit >= 0 else 0,
                  "Profit carried to retained earnings"))
    entry_id = post(ctx.conn, to_date, f"Year-end close to {to_date}", lines, "Closing")
    ctx.conn.execute(
        "INSERT INTO closings (closed_to, entry_id, net_profit) VALUES (?,?,?)",
        (to_date, entry_id, profit))
    ctx.conn.commit()
    return {"ok": True, "closed_to": to_date, "net_profit": profit, "entry_id": entry_id}


@route("GET", r"/api/assets")
def list_assets(ctx):
    ctx.require_user()
    return rows(ctx.conn.execute("SELECT * FROM fixed_assets ORDER BY purchase_date DESC"))


@route("POST", r"/api/assets")
def create_asset(ctx):
    ctx.require_user()
    name = text(ctx.body.get("name"))
    cost = num(ctx.body.get("cost"))
    life = int(num(ctx.body.get("life_months"), 60)) or 60
    if not name or cost <= 0:
        raise HttpError(400, "Give the asset a name and a cost above zero.")
    cur = ctx.conn.execute(
        """INSERT INTO fixed_assets (name, purchase_date, cost, salvage, life_months)
           VALUES (?,?,?,?,?)""",
        (name, text(ctx.body.get("purchase_date"), today()) or today(),
         cost, num(ctx.body.get("salvage")), life))
    ctx.conn.commit()
    return {"id": cur.lastrowid}


@route("DELETE", r"/api/assets/(\d+)")
def delete_asset(ctx, asset_id):
    ctx.require_user()
    ctx.conn.execute("DELETE FROM fixed_assets WHERE id = ?", (asset_id,))
    ctx.conn.commit()
    return {"ok": True}


@route("POST", r"/api/assets/depreciate")
def run_depreciation(ctx):
    """Post one month of straight-line depreciation for every asset due."""
    ctx.require_user()
    upto = text(ctx.body.get("to"), today()) or today()
    posted, total = [], 0.0
    for asset in ctx.conn.execute(
            "SELECT * FROM fixed_assets WHERE active = 1").fetchall():
        monthly = round((asset["cost"] - asset["salvage"]) / max(asset["life_months"], 1), 2)
        if monthly <= 0:
            continue
        already = ctx.conn.execute(
            """SELECT COALESCE(SUM(l.debit), 0) d FROM journal_lines l
               JOIN journal_entries e ON e.id = l.entry_id
               WHERE e.source = 'Depreciation' AND e.source_id = ?""",
            (asset["id"],)).fetchone()["d"]
        remaining = round(asset["cost"] - asset["salvage"] - already, 2)
        if remaining <= 0:
            continue
        amount = min(monthly, remaining)
        memo = f"Depreciation - {asset['name']}"
        post(ctx.conn, upto, memo,
             [(asset["expense_account"], amount, 0, memo),
              ("1590", 0, amount, memo)], "Depreciation", asset["id"])
        ctx.conn.execute("UPDATE fixed_assets SET depreciated_to = ? WHERE id = ?",
                         (upto, asset["id"]))
        posted.append({"asset": asset["name"], "amount": amount})
        total = round(total + amount, 2)
    ctx.conn.commit()
    return {"posted": posted, "total": total}


# --------------------------------------------------------------------------
# Excel exports
# --------------------------------------------------------------------------

class FileResponse:
    def __init__(self, data, filename, content_type):
        self.data = data
        self.filename = filename
        self.content_type = content_type


XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def workbook_response(sheets, name):
    stamp = datetime.now().strftime("%Y-%m-%d")
    safe = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    return FileResponse(xlsx.write(sheets), f"{safe}-{stamp}.xlsx", XLSX_TYPE)


def company_name(conn):
    row = conn.execute("SELECT name FROM company WHERE id = 1").fetchone()
    return row["name"] if row else "Usman Traders"


@route("GET", r"/api/reports/sales/export")
def export_sales(ctx):
    report = report_sales(ctx)
    period = f"{report['from']} to {report['to']}"
    business = company_name(ctx.conn)
    summary = report["summary"]

    overview = xlsx.Sheet("Summary", f"{business} - Sales Report", period)
    overview.columns = [xlsx.Column("Figure", 30), xlsx.Column("Amount", 18, "money")]
    overview.rows = [
        ["Invoices issued", summary["invoices"]],
        ["Gross sales", summary["total"]],
        ["Amount received", summary["paid"]],
        ["Outstanding", summary["outstanding"]],
        ["Discount given", summary["discount"]],
        ["Tax", summary["tax"]],
    ]

    customers = xlsx.Sheet("By Customer", "Sales by Customer", period)
    customers.columns = [xlsx.Column("Customer", 34), xlsx.Column("Invoices", 12, "number"),
                         xlsx.Column("Amount", 16, "money"), xlsx.Column("Outstanding", 16, "money")]
    customers.rows = [[r["name"], r["n"], r["amount"], r["outstanding"]]
                      for r in report["by_customer"]]
    customers.totals = ["Total", sum(r["n"] for r in report["by_customer"]),
                        summary["total"], summary["outstanding"]]

    items = xlsx.Sheet("By Item", "Sales by Item", period)
    items.columns = [xlsx.Column("Code", 12), xlsx.Column("Item", 40),
                     xlsx.Column("Unit", 10), xlsx.Column("Qty Sold", 13, "number"),
                     xlsx.Column("Amount", 16, "money")]
    items.rows = [[r["sku"], r["name"], r["unit"], r["qty"], r["amount"]]
                  for r in report["by_product"]]
    items.totals = ["", "Total", "", sum(r["qty"] for r in report["by_product"]),
                    sum(r["amount"] for r in report["by_product"])]

    daily = xlsx.Sheet("Day by Day", "Daily Sales", period)
    daily.columns = [xlsx.Column("Date", 16), xlsx.Column("Invoices", 12, "number"),
                     xlsx.Column("Amount", 16, "money")]
    daily.rows = [[r["d"], r["n"], r["amount"]] for r in report["by_day"]]
    daily.totals = ["Total", sum(r["n"] for r in report["by_day"]),
                    sum(r["amount"] for r in report["by_day"])]

    return workbook_response([overview, customers, items, daily],
                             f"{business} Sales Report")


@route("GET", r"/api/reports/purchases/export")
def export_purchases(ctx):
    report = report_purchases(ctx)
    period = f"{report['from']} to {report['to']}"
    business = company_name(ctx.conn)
    summary = report["summary"]

    overview = xlsx.Sheet("Summary", f"{business} - Purchase Report", period)
    overview.columns = [xlsx.Column("Figure", 30), xlsx.Column("Amount", 18, "money")]
    overview.rows = [
        ["Purchases recorded", summary["purchases"]],
        ["Total purchased", summary["total"]],
        ["Paid to suppliers", summary["paid"]],
        ["Still owed", summary["outstanding"]],
    ]

    suppliers = xlsx.Sheet("By Supplier", "Purchases by Supplier", period)
    suppliers.columns = [xlsx.Column("Supplier", 34), xlsx.Column("Bills", 12, "number"),
                         xlsx.Column("Amount", 16, "money"), xlsx.Column("Outstanding", 16, "money")]
    suppliers.rows = [[r["name"], r["n"], r["amount"], r["outstanding"]]
                      for r in report["by_supplier"]]
    suppliers.totals = ["Total", sum(r["n"] for r in report["by_supplier"]),
                        summary["total"], summary["outstanding"]]

    items = xlsx.Sheet("By Item", "Purchases by Item", period)
    items.columns = [xlsx.Column("Code", 12), xlsx.Column("Item", 40),
                     xlsx.Column("Unit", 10), xlsx.Column("Qty Bought", 14, "number"),
                     xlsx.Column("Amount", 16, "money")]
    items.rows = [[r["sku"], r["name"], r["unit"], r["qty"], r["amount"]]
                  for r in report["by_product"]]
    items.totals = ["", "Total", "", sum(r["qty"] for r in report["by_product"]),
                    sum(r["amount"] for r in report["by_product"])]

    return workbook_response([overview, suppliers, items], f"{business} Purchase Report")


@route("GET", r"/api/reports/inventory/export")
def export_inventory(ctx):
    report = report_inventory(ctx)
    business = company_name(ctx.conn)
    period = f"As at {today()}"
    summary = report["summary"]

    overview = xlsx.Sheet("Summary", f"{business} - Inventory Report", period)
    overview.columns = [xlsx.Column("Figure", 30), xlsx.Column("Value", 18, "money")]
    overview.rows = [
        ["Active items", summary["products"]],
        ["Stock value at cost", summary["cost_value"]],
        ["Value at sale price", summary["retail_value"]],
        ["Items out of stock", summary["out_of_stock"]],
        ["Items low on stock", summary["low_stock"]],
    ]

    categories = xlsx.Sheet("By Category", "Stock by Category", period)
    categories.columns = [xlsx.Column("Category", 28), xlsx.Column("Items", 10, "number"),
                          xlsx.Column("Total Qty", 14, "number"),
                          xlsx.Column("Value at Cost", 18, "money")]
    categories.rows = [[r["category"], r["n"], r["qty"], r["cost_value"]]
                       for r in report["by_category"]]
    categories.totals = ["Total", sum(r["n"] for r in report["by_category"]),
                         sum(r["qty"] for r in report["by_category"]), summary["cost_value"]]

    stock = xlsx.Sheet("Stock List", "Full Stock List", period)
    stock.columns = [xlsx.Column("Code", 12), xlsx.Column("Item", 40),
                     xlsx.Column("Category", 22), xlsx.Column("Unit", 10),
                     xlsx.Column("On Hand", 12, "number"), xlsx.Column("Reorder At", 12, "number"),
                     xlsx.Column("Cost", 14, "money"), xlsx.Column("Sale Price", 14, "money"),
                     xlsx.Column("Stock Value", 16, "money"), xlsx.Column("Status", 16)]
    stock.rows = [[r["sku"], r["name"], r["category"], r["unit"], r["stock"],
                   r["reorder_level"], r["purchase_price"], r["sale_price"],
                   r["stock_value"], r["stock_state"]] for r in report["items"]]
    stock.totals = ["", "Total", "", "", "", "", "", "", summary["cost_value"], ""]

    return workbook_response([overview, categories, stock], f"{business} Inventory Report")


@route("GET", r"/api/products/export")
def export_products(ctx):
    ctx.require_user()
    business = company_name(ctx.conn)
    sheet = xlsx.Sheet("Item Master", f"{business} - Item Master", f"As at {today()}")
    sheet.columns = [xlsx.Column("Code", 12), xlsx.Column("Item Description", 42),
                     xlsx.Column("Category", 22), xlsx.Column("Unit", 10),
                     xlsx.Column("Pack Size", 14), xlsx.Column("Cost", 14, "money"),
                     xlsx.Column("Sale Price", 14, "money"), xlsx.Column("On Hand", 12, "number"),
                     xlsx.Column("Reorder At", 12, "number"), xlsx.Column("Active", 10)]
    sheet.rows = [[p["sku"], p["name"], p["category"], p["unit"], p["pack_size"],
                   p["purchase_price"], p["sale_price"], p["stock"], p["reorder_level"],
                   "Yes" if p["active"] else "No"] for p in list_products(ctx)]
    return workbook_response([sheet], f"{business} Item Master")


@route("DELETE", r"/api/field/entries/(\d+)")
def delete_field_entry(ctx, entry_id):
    ctx.require_user()
    ctx.conn.execute("DELETE FROM field_entries WHERE id = ?", (entry_id,))
    ctx.conn.commit()
    return {"ok": True}


@route("DELETE", r"/api/stock/moves")
def clear_stock_history(ctx):
    """Wipe the movement ledger and zero every item's stock."""
    ctx.require_admin()
    ctx.conn.execute("DELETE FROM stock_moves")
    ctx.conn.execute("UPDATE products SET stock = 0")
    ctx.conn.execute("UPDATE orders SET stock_applied = 0")
    ctx.conn.execute("UPDATE purchases SET stock_applied = 0")
    ctx.conn.commit()
    return {"ok": True}


TRANSACTION_TABLES = ["invoice_items", "invoices", "order_items", "orders",
                      "purchase_items", "purchases", "stock_moves", "field_entries"]


@route("POST", r"/api/danger/clear")
def clear_data(ctx):
    """Bulk delete. scope=transactions keeps the catalogue and contacts;
    scope=everything also removes items, customers and suppliers."""
    ctx.require_admin()
    scope = text(ctx.body.get("scope"))
    if scope not in ("transactions", "everything"):
        raise HttpError(400, "scope must be 'transactions' or 'everything'.")
    if text(ctx.body.get("confirm")) != "DELETE":
        raise HttpError(400, "Type DELETE to confirm.")

    removed = {}
    tables = list(TRANSACTION_TABLES)
    if scope == "everything":
        tables += ["products", "customers", "suppliers"]
    for table in tables:
        removed[table] = ctx.conn.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"]
        ctx.conn.execute(f"DELETE FROM {table}")
    if scope == "transactions":
        ctx.conn.execute("UPDATE products SET stock = 0")
    ctx.conn.commit()

    if scope == "everything":
        db.seed(ctx.conn)          # put the item master back so the app stays usable
    return {"ok": True, "scope": scope, "removed": removed}


@route("GET", r"/api/appwrite/ping")
def appwrite_ping(ctx):
    """Called automatically when the app opens, to verify the Appwrite setup."""
    ctx.require_user()
    return appwrite_client.client.status()


@route("GET", r"/api/backup")
def download_backup(ctx):
    """Hand back the database file so it can be kept somewhere safe."""
    ctx.require_admin()
    if db.IS_POSTGRES:
        raise HttpError(400, "This installation uses Postgres; take the backup from there.")
    with open(db.DB_PATH, "rb") as handle:
        data = handle.read()
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    return FileResponse(data, f"usmantraders-backup-{stamp}.db", "application/octet-stream")


# --------------------------------------------------------------------------
# Request handling
# --------------------------------------------------------------------------

class Context:
    def __init__(self, conn, body, query, token, user, field_token=""):
        self.conn, self.body, self.query = conn, body, query
        self.token, self.user = token, user
        self.field_token = field_token
        self.set_cookie = None
        self.clear_cookie = False

    def require_user(self):
        if not self.user:
            raise HttpError(401, "Please sign in to continue.")

    def require_admin(self):
        self.require_user()
        if self.user["role"] != "admin":
            raise HttpError(403, "This action requires an administrator account.")

    def require_field_access(self):
        """A signed-in user, or a phone presenting the field token."""
        if self.user:
            return
        if FIELD_TOKEN and hmac.compare_digest(self.field_token or "", FIELD_TOKEN):
            return
        raise HttpError(401, "This device is not authorised for field entry.")


class Handler(BaseHTTPRequestHandler):
    server_version = "Usman Traders"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers ----------------------------------------------------------
    def send_json(self, payload, status=200, cookie=None, clear_cookie=False):
        data = json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie",
                             f"ut_session={cookie}; Path=/; HttpOnly; SameSite=Strict; "
                             f"Max-Age={SESSION_HOURS * 3600}")
        if clear_cookie:
            self.send_header("Set-Cookie", "ut_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, response):
        self.send_response(200)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.data)))
        self.send_header("Content-Disposition",
                         f'attachment; filename="{response.filename}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response.data)

    def current_session(self, conn):
        if not LOGIN_REQUIRED:
            return None, default_user(conn)
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None, None
        token = SimpleCookie(cookie_header).get("ut_session")
        if not token:
            return None, None
        token = token.value
        user_id = db.read_token(conn, token)
        if user_id is None:
            return token, None
        user = conn.execute(
            "SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
        return token, user

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise HttpError(413, "Upload is too large (limit 8 MB).")
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise HttpError(400, "Malformed JSON in request body.")
        return parsed if isinstance(parsed, dict) else {"data": parsed}

    # -- dispatch ---------------------------------------------------------
    def dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if not path.startswith("/api/"):
            return self.serve_static(path)

        conn = db.connect()
        try:
            body = self.read_body() if method in ("POST", "PUT", "DELETE") else {}
            query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
            token, user = self.current_session(conn)
            ctx = Context(conn, body, query, token, user,
                          self.headers.get("X-Field-Token", ""))

            for verb, pattern, handler in ROUTES:
                if verb != method:
                    continue
                match = pattern.match(path)
                if match:
                    args = [int(g) for g in match.groups()]
                    result = handler(ctx, *args)
                    if isinstance(result, FileResponse):
                        return self.send_file(result)
                    return self.send_json(result, cookie=ctx.set_cookie,
                                          clear_cookie=ctx.clear_cookie)
            raise HttpError(404, f"No API endpoint for {method} {path}")
        except HttpError as exc:
            conn.rollback()
            self.send_json({"error": exc.message}, status=exc.status)
        except Exception as exc:  # noqa: BLE001 - surface the message to the UI
            conn.rollback()
            sys.stderr.write(f"[error] {method} {path}: {exc!r}\n")
            self.send_json({"error": f"Server error: {exc}"}, status=500)
        finally:
            conn.close()

    def serve_static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")  # SPA fallback
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    conn = db.init()
    conn.close()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"\n  Usman Traders running at  http://localhost:{port}")
    print(f"  Database               {db.DB_PATH}")
    print("  Default login          admin / admin123   (change it after first sign-in)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
