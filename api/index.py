"""Vercel serverless entry point.

Vercel gives each invocation a read-only project directory, so the database
lives in /tmp (see db.DB_PATH) and is rebuilt from the seed whenever the
instance is recycled. That makes this deployment a **demo** - good for showing
the system, not for keeping real records. Run app.py on your own machine or a
VPS for the live business, or point UT_DB at durable storage.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
from app import Handler  # noqa: E402

db.init().close()


class handler(Handler):  # Vercel looks for a class named exactly "handler"
    pass
