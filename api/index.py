"""Vercel serverless entry point.

Cold starts must stay cheap. Creating the schema and checking the seed on every
invocation means a dozen round trips to a database that may be in another
region - enough to exhaust the function's budget and fail the request. So the
schema is built only when it is actually missing; afterwards a single cheap
query confirms it and the request proceeds.

With DATABASE_URL set the data is durable. Without it the store is SQLite in
/tmp, which the platform wipes whenever an instance recycles - fine for a
demonstration, not for records.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
from app import Handler  # noqa: E402


def ensure_schema():
    try:
        conn = db.connect()
        try:
            conn.execute("SELECT 1 FROM products LIMIT 1").fetchone()
            return
        finally:
            conn.close()
    except Exception:
        pass          # not built yet, or the connection is stale - fall through
    try:
        db.init().close()
    except Exception as exc:
        sys.stderr.write(f"[startup] schema init failed: {exc!r}\n")


ensure_schema()


class handler(Handler):  # Vercel looks for a class named exactly "handler"
    pass
