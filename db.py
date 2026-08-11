"""SQLite schema, connection helpers and seed data for Usman Traders."""

import base64
import hashlib
import hmac
import os
import re
import sqlite3
import time

DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or ""
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# A serverless host gives you a read-only project directory and a scratch /tmp
# that is wiped whenever the instance recycles. That is a demo, and the UI says
# so. Attach a real database and it stops being one - the warning would then be
# a lie, and a warning nobody can trust is worse than none.
DEMO_MODE = bool(os.environ.get("VERCEL")) and not IS_POSTGRES

def _data_dir():
    """Where the database belongs: beside the program the user runs. For a
    frozen .exe that is the folder holding the .exe, not the temporary folder
    its code was unpacked into."""
    import sys
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


LOGO_DIR = getattr(__import__("sys"), "_MEIPASS",
                   os.path.dirname(os.path.abspath(__file__)))

DB_PATH = os.environ.get("UT_DB") or (
    "/tmp/usmantraders.db" if DEMO_MODE
    else os.path.join(_data_dir(), "usmantraders.db")
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'staff',
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    name     TEXT NOT NULL DEFAULT 'My Trading Company',
    tagline  TEXT NOT NULL DEFAULT '',
    logo     TEXT NOT NULL DEFAULT '',
    address  TEXT NOT NULL DEFAULT '',
    city     TEXT NOT NULL DEFAULT '',
    phone    TEXT NOT NULL DEFAULT '',
    email    TEXT NOT NULL DEFAULT '',
    website  TEXT NOT NULL DEFAULT '',
    tax_id   TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'PKR',
    tax_rate REAL NOT NULL DEFAULT 0,
    footer   TEXT NOT NULL DEFAULT 'Thank you for your business.'
);

CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    contact    TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    city       TEXT NOT NULL DEFAULT '',
    tax_id     TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    contact    TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    city       TEXT NOT NULL DEFAULT '',
    tax_id     TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sku            TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    category       TEXT NOT NULL DEFAULT '',
    unit           TEXT NOT NULL DEFAULT 'pcs',
    pack_size      TEXT NOT NULL DEFAULT '',
    purchase_price REAL NOT NULL DEFAULT 0,
    sale_price     REAL NOT NULL DEFAULT 0,
    stock          REAL NOT NULL DEFAULT 0,
    reorder_level  REAL NOT NULL DEFAULT 0,
    supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    notes          TEXT NOT NULL DEFAULT '',
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no        TEXT NOT NULL UNIQUE,
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    order_date      TEXT NOT NULL,
    delivery_date   TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'Pending',
    delivery_status TEXT NOT NULL DEFAULT 'Not Dispatched',
    tracking_note   TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    subtotal        REAL NOT NULL DEFAULT 0,
    discount        REAL NOT NULL DEFAULT 0,
    tax             REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL DEFAULT 0,
    stock_applied   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty        REAL NOT NULL DEFAULT 0,
    price      REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no   TEXT NOT NULL UNIQUE,
    order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    invoice_date TEXT NOT NULL,
    due_date     TEXT NOT NULL DEFAULT '',
    subtotal     REAL NOT NULL DEFAULT 0,
    discount     REAL NOT NULL DEFAULT 0,
    tax          REAL NOT NULL DEFAULT 0,
    total        REAL NOT NULL DEFAULT 0,
    paid         REAL NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'Unpaid',
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty        REAL NOT NULL DEFAULT 0,
    price      REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_no   TEXT NOT NULL UNIQUE,
    supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
    purchase_date TEXT NOT NULL,
    bill_no       TEXT NOT NULL DEFAULT '',
    subtotal      REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    tax           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    paid          REAL NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'Received',
    notes         TEXT NOT NULL DEFAULT '',
    stock_applied INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    qty         REAL NOT NULL DEFAULT 0,
    price       REAL NOT NULL DEFAULT 0,
    line_total  REAL NOT NULL DEFAULT 0
);

-- Entries captured in the field, possibly with no connection. They are held on
-- the phone until it can reach the server, so client_id is generated by the
-- device and kept unique: a retry after a reply went missing cannot duplicate
-- the booking. They stay separate from the ledger until reviewed and converted.
CREATE TABLE IF NOT EXISTS field_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL DEFAULT 'Booking',
    party_name  TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    city        TEXT NOT NULL DEFAULT '',
    entry_date  TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    items       TEXT NOT NULL DEFAULT '[]',
    total       REAL NOT NULL DEFAULT 0,
    device      TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'Pending',
    linked_id   INTEGER,
    linked_no   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Double-entry bookkeeping. Every financial event writes a balanced journal
-- entry, and the statements are derived from those entries rather than
-- recalculated from documents - so the books can always be traced and proved.
CREATE TABLE IF NOT EXISTS accounts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    code     TEXT NOT NULL UNIQUE,
    name     TEXT NOT NULL,
    type     TEXT NOT NULL,               -- Asset, Liability, Equity, Income, Expense
    subtype  TEXT NOT NULL DEFAULT '',
    is_cash  INTEGER NOT NULL DEFAULT 0,  -- cash and bank, for the cash summary
    system   INTEGER NOT NULL DEFAULT 0,  -- posted to automatically; do not delete
    active   INTEGER NOT NULL DEFAULT 1,
    notes    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_no   TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    memo       TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'Manual',
    source_id  INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id     INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    debit        REAL NOT NULL DEFAULT 0,
    credit       REAL NOT NULL DEFAULT 0,
    memo         TEXT NOT NULL DEFAULT '',
    -- ticked off against a bank statement during reconciliation
    cleared      INTEGER NOT NULL DEFAULT 0,
    cleared_date TEXT NOT NULL DEFAULT ''
);

-- Each year-end close records how far the books were closed and the entry
-- that swept profit into retained earnings, so it can be traced or undone.
CREATE TABLE IF NOT EXISTS closings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    closed_to  TEXT NOT NULL,
    entry_id   INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
    net_profit REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Straight-line depreciation: cost spread evenly over a life in months.
CREATE TABLE IF NOT EXISTS fixed_assets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    cost          REAL NOT NULL DEFAULT 0,
    salvage       REAL NOT NULL DEFAULT 0,
    life_months   INTEGER NOT NULL DEFAULT 60,
    asset_account TEXT NOT NULL DEFAULT '1500',
    expense_account TEXT NOT NULL DEFAULT '6800',
    depreciated_to TEXT NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_source ON journal_entries(source, source_id);

CREATE TABLE IF NOT EXISTS stock_moves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    move_date  TEXT NOT NULL DEFAULT (datetime('now')),
    kind       TEXT NOT NULL,
    qty        REAL NOT NULL,
    balance    REAL NOT NULL DEFAULT 0,
    reference  TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
"""


# --------------------------------------------------------------------------
# Storage backend
#
# SQLite by default - one file, nothing to install. Set DATABASE_URL to a
# Postgres connection string and the same application SQL runs there instead,
# which is what makes durable hosting possible. The differences between the two
# dialects are absorbed here so no query elsewhere has to know which is in use.
# --------------------------------------------------------------------------

# Keep our tables in their own schema. A hosted database is often shared with
# other projects, and "public" is where names collide.
PG_SCHEMA = os.environ.get("UT_PG_SCHEMA", "usmantraders")

# Bumped whenever tables OR seeded rows change. A serverless instance uses this
# to notice that its database predates the current code. Checking for one known
# table is not enough - that table exists happily while newer ones are missing -
# and neither is checking tables alone, since new chart accounts are data.
SCHEMA_VERSION = "4"

_INSERT = re.compile(r"^\s*INSERT\s+INTO\s+(\w+)", re.IGNORECASE)
_NO_ID_TABLES = {"settings"}

if IS_POSTGRES:
    import psycopg2
    import psycopg2.extensions
    import psycopg2.extras
    import psycopg2.pool

    # NUMERIC arrives as Decimal, which json.dumps would render as a quoted
    # string and the browser would then refuse to do arithmetic on.
    psycopg2.extensions.register_type(psycopg2.extensions.new_type(
        psycopg2.extensions.DECIMAL.values, "DEC2FLOAT",
        lambda value, _cur: float(value) if value is not None else None))


def _to_postgres(sql):
    """Rewrite the SQLite dialect the queries are written in."""
    sql = sql.replace("?", "%s")
    # SQLite date arithmetic used by the dashboard trend
    sql = sql.replace("date('now', '-13 days')", "to_char(CURRENT_DATE - 13, 'YYYY-MM-DD')")
    return sql


class Cursor:
    """Cursor that speaks either dialect and always exposes lastrowid."""

    def __init__(self, raw, postgres):
        self._raw = raw
        self._postgres = postgres
        self.lastrowid = None

    def execute(self, sql, params=()):
        if not self._postgres:
            self._raw.execute(sql, params)
            self.lastrowid = self._raw.lastrowid
            return self

        statement = _to_postgres(sql)
        match = _INSERT.match(statement)
        returns_id = bool(match) and match.group(1).lower() not in _NO_ID_TABLES \
            and "returning" not in statement.lower()
        if returns_id:
            statement += " RETURNING id"
        self._raw.execute(statement, params)
        self.lastrowid = self._raw.fetchone()[0] if returns_id else None
        return self

    def executemany(self, sql, seq):
        statement = _to_postgres(sql) if self._postgres else sql
        self._raw.executemany(statement, seq)
        return self

    def fetchone(self):
        return self._raw.fetchone()

    def fetchall(self):
        return self._raw.fetchall()

    def __iter__(self):
        return iter(self._raw.fetchall())


class Connection:
    """Thin wrapper so callers can keep using conn.execute(...) on both engines."""

    def __init__(self, raw, postgres, pooled=False):
        self._raw = raw
        self.postgres = postgres
        self.pooled = pooled

    def cursor(self):
        raw = (self._raw.cursor(cursor_factory=psycopg2.extras.DictCursor)
               if self.postgres else self._raw.cursor())
        return Cursor(raw, self.postgres)

    def execute(self, sql, params=()):
        return self.cursor().execute(sql, params)

    def executescript(self, script):
        if self.postgres:
            self.cursor().execute(script)
        else:
            self._raw.executescript(script)
        return self

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        if self.pooled:
            # hand it back clean, never mid-transaction
            try:
                self._raw.rollback()
            except Exception:
                pass
            pool().putconn(self._raw)
        else:
            self._raw.close()


_POOL = None


def pool():
    """Reuse connections. A hosted database sits across the network, where
    opening a fresh TLS connection per request costs more than the query."""
    global _POOL
    if _POOL is None:
        _POOL = psycopg2.pool.ThreadedConnectionPool(
            1, 8, DATABASE_URL, connect_timeout=15,
            # applied at connect time, so it costs no extra round trip
            options=f"-c search_path={PG_SCHEMA},public")
    return _POOL


def connect():
    if IS_POSTGRES:
        return Connection(pool().getconn(), True, pooled=True)
    raw = sqlite3.connect(DB_PATH)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA foreign_keys = ON")
    return Connection(raw, False)


def hash_password(password, salt=None):
    """PBKDF2-HMAC-SHA256, 200k iterations. Returns (hash_hex, salt_hex)."""
    salt = salt or os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return digest.hex(), salt


def verify_password(password, password_hash, salt):
    candidate, _ = hash_password(password, salt)
    return hmac.compare_digest(candidate, password_hash)


# --------------------------------------------------------------------------
# Sessions
#
# Signed cookies rather than a sessions table. A serverless host runs several
# instances that share no storage, so a row written by one is invisible to the
# next and the user gets bounced to the login screen at random. A signature any
# instance can verify with the same secret has no such problem.
# --------------------------------------------------------------------------

SESSION_HOURS = 12


def session_secret(conn):
    """Shared signing key. Set UT_SECRET when running more than one
    instance; otherwise one is generated and kept in the database."""
    from_env = os.environ.get("UT_SECRET")
    if from_env:
        return from_env.encode()
    row = conn.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()
    if row:
        return bytes.fromhex(row["value"])
    key = os.urandom(32)
    upsert = ("INSERT INTO settings (key, value) VALUES ('session_secret', ?) "
              "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" if conn.postgres
              else "INSERT OR REPLACE INTO settings (key, value) VALUES ('session_secret', ?)")
    conn.execute(upsert, (key.hex(),))
    conn.commit()
    return key


def _sign(secret, payload):
    return hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()[:40]


def make_token(conn, user_id):
    payload = f"{user_id}.{int(time.time()) + SESSION_HOURS * 3600}"
    return f"{payload}.{_sign(session_secret(conn), payload)}"


def read_token(conn, token):
    """Return the user id carried by a valid, unexpired token, else None."""
    parts = (token or "").split(".")
    if len(parts) != 3:
        return None
    user_id, expires, signature = parts
    payload = f"{user_id}.{expires}"
    if not hmac.compare_digest(signature, _sign(session_secret(conn), payload)):
        return None
    try:
        if int(expires) < time.time():
            return None
        return int(user_id)
    except ValueError:
        return None


# Usman Traders & Suppliers item master.
# Item descriptions are kept verbatim so they match the codes already in use.
# Sale price is taken from the "RS n" printed in the description where present;
# purchase price and opening stock start at zero for the business to fill in.
# (sku, name, category, unit, pack_size, purchase_price, sale_price, stock, reorder_level)
SEED_PRODUCTS = [
    ("00001", "ACHAR SACHET RS;10", "Achar & Chatni", "pcs", "Sachet", 0, 10, 0, 0),
    ("00002", "ACHAR 5KG BUCKET", "Achar & Chatni", "bucket", "5 kg", 0, 0, 0, 0),
    ("00003", "ACHAR 10KG BUCKET", "Achar & Chatni", "bucket", "10 kg", 0, 0, 0, 0),
    ("00004", "ACHAR 20 KG BUCKET", "Achar & Chatni", "bucket", "20 kg", 0, 0, 0, 0),
    ("00005", "HARI MIRCH POWDER RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00006", "BIRYANI MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00007", "PULLAO RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00008", "HALDI POWDER RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00009", "CHAT MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00010", "FISH MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00011", "ACHAR GHOSHT RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00012", "TIKKA MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00013", "DAL SABZI MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00014", "QUORMA MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00015", "KARAHI GHOSHT MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00016", "DHANIA POWDER RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00017", "G/MASALA POWDER RS 20", "Masala & Spices", "pcs", "Sachet", 0, 20, 0, 0),
    ("00018", "SALAN MASALA RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00019", "G/MASALA POWDER RS 10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00020", "NEEL RS 20", "Household", "pcs", "Sachet", 0, 20, 0, 0),
    ("00021", "NEEL RS 30", "Household", "pcs", "Sachet", 0, 30, 0, 0),
    ("00022", "NEEL RS 50", "Household", "pcs", "Sachet", 0, 50, 0, 0),
    ("00023", "SARSON OIL RS;10", "Oils", "pcs", "Sachet", 0, 10, 0, 0),
    ("00024", "SARSON OIL RS;20", "Oils", "pcs", "Sachet", 0, 20, 0, 0),
    ("00025", "COCONUT OIL RS;20", "Oils", "pcs", "Sachet", 0, 20, 0, 0),
    ("00026", "CAANDIL RS;10", "Household", "pcs", "Pack", 0, 10, 0, 0),
    ("00027", "CAANDIL RS;20", "Household", "pcs", "Pack", 0, 20, 0, 0),
    ("00028", "CHILLI SAUCE 750 ML", "Sauces & Vinegar", "bottle", "750 ml", 0, 0, 0, 0),
    ("00029", "SOYA SAUCE 750 ML", "Sauces & Vinegar", "bottle", "750 ml", 0, 0, 0, 0),
    ("00030", "PLAIN VENGAR 750 ML", "Sauces & Vinegar", "bottle", "750 ml", 0, 0, 0, 0),
    ("00031", "SYRUP ICE CREAM SODA 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00032", "SYRUP RED 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00033", "SYRUP FALSA 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00034", "SYRUP PINE APPLE 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00035", "SYRUP MANGO 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00036", "SYRUP STRAWBERRY 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00037", "SYRUP LEECHI 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00038", "SYRUP BLUEBERRYI 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00039", "SYRUP PEACH 750 ML", "Syrups", "bottle", "750 ml", 0, 0, 0, 0),
    ("00040", "SAVHET RED CHILLI POWDER", "Masala & Spices", "pcs", "Sachet", 0, 0, 0, 0),
    ("00041", "HAND WASH 500ML ALOEVERA", "Household", "bottle", "500 ml", 0, 0, 0, 0),
    ("00042", "HAND WASH 500ML COCONUT", "Household", "bottle", "500 ml", 0, 0, 0, 0),
    ("00043", "HAND WASH 500ML LAVENDER", "Household", "bottle", "500 ml", 0, 0, 0, 0),
    ("00044", "HAND WASH 500ML ROSE", "Household", "bottle", "500 ml", 0, 0, 0, 0),
    ("00045", "CHATNI POODINA", "Achar & Chatni", "pcs", "", 0, 0, 0, 0),
    ("00046", "QUORMA MASALA RS 20", "Masala & Spices", "pcs", "Sachet", 0, 20, 0, 0),
    ("00047", "SARSO OIL RS 60", "Oils", "pcs", "Bottle", 0, 60, 0, 0),
    ("00048", "COCNUT OIL RS60", "Oils", "pcs", "Bottle", 0, 60, 0, 0),
    ("00049", "SALAN MASALA RS 20", "Masala & Spices", "pcs", "Sachet", 0, 20, 0, 0),
    ("000049", "KARAHAI GOSHT RS20", "Masala & Spices", "pcs", "Sachet", 0, 20, 0, 0),
    ("00050", "MURGI MASALA RS 20", "Masala & Spices", "pcs", "Sachet", 0, 20, 0, 0),
    ("00051", "RED CHILLI CUTTER", "Masala & Spices", "pcs", "", 0, 0, 0, 0),
    ("00052", "RED CHILLI POWDER 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00053", "DHANIYA POWDER 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00054", "HALDI POWDER 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00055", "RED CHILLI CUTTER 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00056", "MAMTA TEA SACHET RS20", "Tea", "pcs", "Sachet", 0, 20, 0, 0),
    ("00057", "SINDHRI ACHAR SACHET RS 10", "Achar & Chatni", "pcs", "Sachet", 0, 10, 0, 0),
    ("00058", "MAMTA TEA SACHET RS;10", "Tea", "pcs", "Sachet", 0, 10, 0, 0),
    ("00059", "TEA MIXTURE 5KG JAR", "Tea", "jar", "5 kg", 0, 0, 0, 0),
    ("00060", "AJEENO MOTO SACHET RS10", "Masala & Spices", "pcs", "Sachet", 0, 10, 0, 0),
    ("00061", "ZEERA 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00062", "CHAAT MASALA 1KG", "Masala & Spices", "pack", "1 kg", 0, 0, 0, 0),
    ("00063", "BUCKET 500GM ACHAR", "Achar & Chatni", "bucket", "500 g", 0, 0, 0, 0),
]

# Customers and suppliers start empty on purpose - placeholder parties in a live
# ledger are a liability (they end up on real invoices). Add them from the UI.
SEED_CUSTOMERS = []
SEED_SUPPLIERS = []


# Stand-in mark in the brand's colours, shown until a real logo is uploaded
# from Company Profile (Settings -> Company -> Upload logo).
PLACEHOLDER_LOGO_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<rect width="200" height="200" rx="24" fill="#d92d20"/>
<circle cx="100" cy="100" r="72" fill="#e8ecb4"/>
<circle cx="100" cy="100" r="66" fill="none" stroke="#d92d20" stroke-width="2"
        stroke-dasharray="7 7"/>
<text x="100" y="104" text-anchor="middle" font-family="Georgia,serif" font-size="52"
      font-weight="700" fill="#c1121f">UT</text>
<text x="100" y="132" text-anchor="middle" font-family="Helvetica,Arial,sans-serif"
      font-size="15" letter-spacing="2.5" fill="#7a1416">TRADERS</text>
</svg>"""


LOGO_FILE = os.path.join(LOGO_DIR, "static", "logo.png")


def placeholder_logo():
    encoded = base64.b64encode(PLACEHOLDER_LOGO_SVG.encode()).decode()
    return f"data:image/svg+xml;base64,{encoded}"


def default_logo():
    """The company mark, inlined so it travels with the database."""
    try:
        with open(LOGO_FILE, "rb") as handle:
            return "data:image/png;base64," + base64.b64encode(handle.read()).decode()
    except OSError:
        return placeholder_logo()


# A chart a trading business can actually use, in the usual numbering ranges.
# (code, name, type, subtype, is_cash, system)
CHART = [
    ("1000", "Cash in Hand",        "Asset",     "Current Asset", 1, 1),
    ("1010", "Bank Account",        "Asset",     "Current Asset", 1, 1),
    ("1100", "Accounts Receivable", "Asset",     "Current Asset", 0, 1),
    ("1200", "Inventory",           "Asset",     "Current Asset", 0, 1),
    ("1500", "Equipment",           "Asset",     "Fixed Asset",   0, 0),
    ("2000", "Accounts Payable",    "Liability", "Current Liability", 0, 1),
    ("2100", "Tax Payable",         "Liability", "Current Liability", 0, 1),
    ("3000", "Owner's Capital",     "Equity",    "", 0, 1),
    ("3900", "Retained Earnings",   "Equity",    "", 0, 1),
    ("4000", "Sales",               "Income",    "", 0, 1),
    ("4100", "Sales Discounts",     "Income",    "Contra", 0, 1),
    ("5000", "Cost of Goods Sold",  "Expense",   "Cost of Sales", 0, 1),
    ("6000", "Salaries & Wages",    "Expense",   "Operating", 0, 0),
    ("6100", "Rent",                "Expense",   "Operating", 0, 0),
    ("6200", "Utilities",           "Expense",   "Operating", 0, 0),
    ("6300", "Transport & Delivery","Expense",   "Operating", 0, 0),
    ("6400", "Packing & Supplies",  "Expense",   "Operating", 0, 0),
    ("6800", "Depreciation",        "Expense",   "Operating", 0, 1),
    ("6900", "Other Expenses",      "Expense",   "Operating", 0, 0),
    ("1590", "Accumulated Depreciation", "Asset", "Fixed Asset", 0, 1),
]


def seed(conn):
    """Populate first-run defaults: admin user, company profile, item master."""
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) c FROM company")
    if cur.fetchone()["c"] == 0:
        cur.execute(
            """INSERT INTO company (id, name, tagline, logo, address, city, phone, email,
                                    currency, tax_rate, footer)
               VALUES (1, 'Usman Traders & Suppliers',
                       'عثمان ٹریڈرز اینڈ سپلائرز  |  Achar • Masala • Food Items',
                       ?, '', 'Karachi', '', '', 'PKR', 0,
                       'Thank you for your business.')""",
            (default_logo(),),
        )
    else:
        # Installations seeded before the real mark existed still carry the
        # stand-in SVG. Replace that, but never a logo the business uploaded.
        current = cur.execute("SELECT logo FROM company WHERE id = 1").fetchone()
        if current and (not current["logo"] or current["logo"].startswith("data:image/svg+xml")):
            cur.execute("UPDATE company SET logo = ? WHERE id = 1", (default_logo(),))

    # Insert per account rather than only when the table is empty, so accounts
    # added in a later version reach databases that already exist.
    have = {r["code"] for r in cur.execute("SELECT code FROM accounts").fetchall()}
    missing = [a for a in CHART if a[0] not in have]
    if missing:
        cur.executemany(
            """INSERT INTO accounts (code, name, type, subtype, is_cash, system)
               VALUES (?,?,?,?,?,?)""", missing)

    cur.execute("SELECT COUNT(*) c FROM users")
    if cur.fetchone()["c"] == 0:
        pw_hash, salt = hash_password("admin123")
        cur.execute(
            "INSERT INTO users (username, full_name, role, password_hash, salt) VALUES (?,?,?,?,?)",
            ("admin", "System Administrator", "admin", pw_hash, salt),
        )

    cur.execute("SELECT COUNT(*) c FROM suppliers")
    if cur.fetchone()["c"] == 0:
        cur.executemany(
            "INSERT INTO suppliers (name, contact, phone, email, address, city) VALUES (?,?,?,?,?,?)",
            SEED_SUPPLIERS,
        )

    cur.execute("SELECT COUNT(*) c FROM customers")
    if cur.fetchone()["c"] == 0:
        cur.executemany(
            "INSERT INTO customers (name, contact, phone, email, address, city) VALUES (?,?,?,?,?,?)",
            SEED_CUSTOMERS,
        )

    cur.execute("SELECT COUNT(*) c FROM products")
    if cur.fetchone()["c"] == 0:
        cur.executemany(
            """INSERT INTO products (sku, name, category, unit, pack_size, purchase_price,
                                     sale_price, stock, reorder_level)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            SEED_PRODUCTS,
        )
        for row in cur.execute("SELECT id, stock FROM products WHERE stock <> 0").fetchall():
            cur.execute(
                "INSERT INTO stock_moves (product_id, kind, qty, balance, reference, note) VALUES (?,?,?,?,?,?)",
                (row["id"], "Opening", row["stock"], row["stock"], "OPENING", "Opening stock"),
            )

    conn.commit()


# Overload ROUND so the two-argument form the reports use accepts the double
# precision columns, matching SQLite's behaviour.
PG_COMPAT = """
CREATE OR REPLACE FUNCTION round(double precision, integer) RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $fn$ SELECT round($1::numeric, $2) $fn$;
"""


def postgres_schema(sql):
    """Translate the canonical SQLite schema into Postgres DDL."""
    sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    sql = re.sub(r"\bREAL\b", "DOUBLE PRECISION", sql)
    sql = sql.replace(
        "(datetime('now'))",
        "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'))")
    return sql


def init():
    conn = connect()
    if conn.postgres:
        conn.executescript(f'CREATE SCHEMA IF NOT EXISTS "{PG_SCHEMA}"')
        conn.executescript(f'SET search_path TO "{PG_SCHEMA}", public')
        conn.executescript(PG_COMPAT)
        conn.executescript(postgres_schema(SCHEMA))
    else:
        conn.executescript(SCHEMA)
    conn.commit()
    seed(conn)
    upsert = ("INSERT INTO settings (key, value) VALUES ('schema_version', ?) "
              "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" if conn.postgres
              else "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)")
    conn.execute(upsert, (SCHEMA_VERSION,))
    conn.commit()
    return conn


def next_number(conn, table, column, prefix):
    """Generate the next sequential document number, e.g. INV-0007."""
    row = conn.execute(f"SELECT {column} n FROM {table} ORDER BY id DESC LIMIT 1").fetchone()
    seq = 1
    if row and row["n"] and "-" in row["n"]:
        tail = row["n"].rsplit("-", 1)[-1]
        if tail.isdigit():
            seq = int(tail) + 1
    return f"{prefix}-{seq:04d}"
