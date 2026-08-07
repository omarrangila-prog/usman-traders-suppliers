#!/usr/bin/env python3
"""SupplyDesk - business management server for a trading & supply company.

Runs on the Python standard library only: http.server + sqlite3.
    python3 app.py           # http://localhost:8000
    python3 app.py 9000      # custom port
"""

import json
import mimetypes
import os
import re
import secrets
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SESSION_HOURS = 12
MAX_BODY = 8 * 1024 * 1024  # 8 MB, enough for a base64 logo upload

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

@route("POST", r"/api/login")
def login(ctx):
    username = text(ctx.body.get("username"))
    password = text(ctx.body.get("password"))
    user = ctx.conn.execute(
        "SELECT * FROM users WHERE username = ? AND active = 1", (username,)
    ).fetchone()
    if not user or not db.verify_password(password, user["password_hash"], user["salt"]):
        raise HttpError(401, "Invalid username or password.")

    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)).replace(microsecond=0)
    ctx.conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
        (token, user["id"], expires.isoformat()),
    )
    ctx.conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso(),))
    ctx.conn.commit()
    ctx.set_cookie = token
    return {"user": {"id": user["id"], "username": user["username"],
                     "full_name": user["full_name"], "role": user["role"]}}


@route("POST", r"/api/logout")
def logout(ctx):
    if ctx.token:
        ctx.conn.execute("DELETE FROM sessions WHERE token = ?", (ctx.token,))
        ctx.conn.commit()
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
        ctx.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
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


@route("GET", r"/api/branding")
def get_branding(ctx):
    """Name, tagline and logo only - readable before sign-in for the login screen."""
    row = ctx.conn.execute("SELECT name, tagline, logo FROM company WHERE id = 1").fetchone()
    return dict(row, demo=db.DEMO_MODE) if row else {"demo": db.DEMO_MODE}


@route("GET", r"/api/company")
def get_company(ctx):
    ctx.require_user()
    row = ctx.conn.execute("SELECT * FROM company WHERE id = 1").fetchone()
    return dict(row, demo=db.DEMO_MODE)


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
    used = ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM order_items WHERE product_id = ?)
                + (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?)
                + (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?) AS c""",
        (product_id, product_id, product_id)).fetchone()["c"]
    if used:
        raise HttpError(400, "This product appears on orders, invoices or purchases. "
                             "Mark it inactive instead of deleting it.")
    ctx.conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
    ctx.conn.commit()
    return {"ok": True}


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
    used = ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM orders WHERE customer_id = ?)
                + (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) AS c""",
        (customer_id, customer_id)).fetchone()["c"]
    if used:
        raise HttpError(400, "This customer has orders or invoices. Mark them inactive instead.")
    ctx.conn.execute("DELETE FROM customers WHERE id = ?", (customer_id,))
    ctx.conn.commit()
    return {"ok": True}


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
    used = ctx.conn.execute(
        """SELECT (SELECT COUNT(*) FROM purchases WHERE supplier_id = ?)
                + (SELECT COUNT(*) FROM products WHERE supplier_id = ?) AS c""",
        (supplier_id, supplier_id)).fetchone()["c"]
    if used:
        raise HttpError(400, "This supplier is linked to purchases or products. "
                             "Mark them inactive instead.")
    ctx.conn.execute("DELETE FROM suppliers WHERE id = ?", (supplier_id,))
    ctx.conn.commit()
    return {"ok": True}


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
    elif not should_apply and order["stock_applied"]:
        apply_order_stock(ctx.conn, order_id, +1)
    ctx.conn.commit()
    return {"ok": True, "status": status, "delivery_status": delivery}


@route("DELETE", r"/api/orders/(\d+)")
def delete_order(ctx, order_id):
    ctx.require_user()
    order = ctx.conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise HttpError(404, "Order not found.")
    if ctx.conn.execute("SELECT 1 FROM invoices WHERE order_id = ?", (order_id,)).fetchone():
        raise HttpError(400, "Delete the invoice for this order first.")
    if order["stock_applied"]:
        apply_order_stock(ctx.conn, order_id, +1)
    ctx.conn.execute("DELETE FROM orders WHERE id = ?", (order_id,))
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
    ctx.conn.commit()
    return {"paid": paid, "status": invoice_status(invoice["total"], paid)}


@route("DELETE", r"/api/invoices/(\d+)")
def delete_invoice(ctx, invoice_id):
    ctx.require_admin()
    invoice = ctx.conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not invoice:
        raise HttpError(404, "Invoice not found.")
    if invoice["order_id"] is None:
        for item in ctx.conn.execute(
                "SELECT * FROM invoice_items WHERE invoice_id = ?", (invoice_id,)).fetchall():
            log_move(ctx.conn, item["product_id"], "Sale Return", item["qty"],
                     invoice["invoice_no"], "Invoice deleted")
    ctx.conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
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
    ctx.conn.commit()
    return {"paid": round(paid, 2)}


@route("DELETE", r"/api/purchases/(\d+)")
def delete_purchase(ctx, purchase_id):
    ctx.require_user()
    purchase = ctx.conn.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    if purchase["stock_applied"]:
        apply_purchase_stock(ctx.conn, purchase_id, -1)
    ctx.conn.execute("DELETE FROM purchases WHERE id = ?", (purchase_id,))
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
# Request handling
# --------------------------------------------------------------------------

class Context:
    def __init__(self, conn, body, query, token, user):
        self.conn, self.body, self.query = conn, body, query
        self.token, self.user = token, user
        self.set_cookie = None
        self.clear_cookie = False

    def require_user(self):
        if not self.user:
            raise HttpError(401, "Please sign in to continue.")

    def require_admin(self):
        self.require_user()
        if self.user["role"] != "admin":
            raise HttpError(403, "This action requires an administrator account.")


class Handler(BaseHTTPRequestHandler):
    server_version = "SupplyDesk"
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
                             f"sd_session={cookie}; Path=/; HttpOnly; SameSite=Strict; "
                             f"Max-Age={SESSION_HOURS * 3600}")
        if clear_cookie:
            self.send_header("Set-Cookie", "sd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
        self.end_headers()
        self.wfile.write(data)

    def current_session(self, conn):
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None, None
        token = SimpleCookie(cookie_header).get("sd_session")
        if not token:
            return None, None
        token = token.value
        user = conn.execute(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token = ? AND s.expires_at > ? AND u.active = 1""",
            (token, now_iso())).fetchone()
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
            ctx = Context(conn, body, query, token, user)

            for verb, pattern, handler in ROUTES:
                if verb != method:
                    continue
                match = pattern.match(path)
                if match:
                    args = [int(g) for g in match.groups()]
                    result = handler(ctx, *args)
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
    print(f"\n  SupplyDesk running at  http://localhost:{port}")
    print(f"  Database               {db.DB_PATH}")
    print("  Default login          admin / admin123   (change it after first sign-in)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
