"""Sharing data between the office desktop and the cloud.

The desktop keeps its own file and works with no internet. When it does have a
connection it calls POST /api/sync once: it sends what changed on this computer
and what it currently holds, and gets back everything it is missing.

Three things make this safe rather than merely plausible.

*Identity.* Two machines both numbering rows from 1 cannot be merged, so every
travelling row carries a uid. Rows the two sides seed for themselves derive
theirs from the business key, so the item master is recognised as the same list
on both sides instead of being duplicated.

*Noticing changes.* Nothing depends on a write path remembering to flag a row.
The content of every row is hashed and compared against what was agreed at the
last sync, so any difference is found however it was made - including by a code
path written later that knows nothing about sharing.

*Losing nothing.* When both sides changed the same record, one version is kept
and the other is written to sync_conflicts rather than discarded. Where one
change was shared before the other was made, the later one wins. Where both were
made between the same two syncs, nothing recorded when either happened, so which
one wins is not meaningful - what matters, and what is guaranteed, is that both
machines end up agreeing and the other version can still be read.

A document and its lines travel as one piece, so line numbering stays a purely
local matter.
"""

import hashlib
import json
import time

import db

# Which foreign keys point where. These columns travel as the other row's uid
# and are turned back into a local id on arrival.
REFERENCES = {
    "products": {"supplier_id": "suppliers"},
    "orders": {"customer_id": "customers"},
    "invoices": {"customer_id": "customers", "order_id": "orders"},
    "purchases": {"supplier_id": "suppliers"},
    "stock_moves": {"product_id": "products"},
}

# A document carries its own lines: (table, column pointing back, its references)
CHILDREN = {
    "orders": ("order_items", "order_id", {"product_id": "products"}),
    "invoices": ("invoice_items", "invoice_id", {"product_id": "products"}),
    "purchases": ("purchase_items", "purchase_id", {"product_id": "products"}),
    "journal_entries": ("journal_lines", "entry_id", {"account_id": "accounts"}),
}

# created_at is when a row was written into *this* database. The two sides seed
# their copies of the item master at different moments, so it always differs and
# would make every seeded row look changed on both sides - turning the very
# first sync into sixty-nine conflicts over nothing. The dates that matter to
# the business - order_date, invoice_date - are ordinary columns and do travel.
NEVER_TRAVELS = {"id", "uid", "updated_at", "created_at"}

# Columns no two rows may share. Neither machine can see the other's numbering
# while they are apart, so both reach for the same next number and the merge
# would be refused. The arriving document is given a free number instead - it is
# a different document and must not be lost or allowed to overwrite the other.
UNIQUE_COLUMNS = {
    "orders": ("order_no", "ORD"),
    "invoices": ("invoice_no", "INV"),
    "purchases": ("purchase_no", "PUR"),
    "products": ("sku", None),
    "accounts": ("code", None),
    "field_entries": ("client_id", None),
}


def free_up_number(conn, entity, fields, uid):
    """Give an arriving row its own number if the one it came with is taken.
    Returns a note when it had to be renamed, so someone can be told."""
    spec = UNIQUE_COLUMNS.get(entity)
    if not spec:
        return None
    column, prefix = spec
    value = fields.get(column)
    if not value:
        return None
    clash = conn.execute(
        f"SELECT uid FROM {entity} WHERE {column} = ? AND uid <> ?", (value, uid)).fetchone()
    if not clash:
        return None
    if prefix:
        fields[column] = db.next_number(conn, entity, column, prefix)
    else:
        # A code is the business's own label, so keep it recognisable rather
        # than replacing it with a number nobody will know.
        suffix, candidate = 2, f"{value}-{2}"
        while conn.execute(f"SELECT 1 FROM {entity} WHERE {column} = ?",
                           (candidate,)).fetchone():
            suffix += 1
            candidate = f"{value}-{suffix}"
        fields[column] = candidate
    return {"column": column, "was": value, "now": fields[column]}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


def columns_of(conn, table):
    if conn.postgres:
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            (db.PG_SCHEMA, table)).fetchall()
        return [r["column_name"] for r in rows]
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def normalise(value):
    """Flatten a value to text before hashing.

    Python prints 3000.0 where JavaScript prints 3000, and one database hands
    back an integer where the other hands back a float. Left alone, the two
    sides would hash the same record differently, decide every row had changed
    and invent conflicts out of nothing. Reducing every value to one agreed
    spelling removes the question."""
    if isinstance(value, dict):
        return {k: normalise(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalise(v) for v in value]
    if value is None:
        return None
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        number = float(value)
        if number == int(number) and abs(number) < 1e15:
            return str(int(number))
        return f"{number:.6f}".rstrip("0").rstrip(".")
    return str(value)


def canonical(payload):
    """One byte-for-byte representation, so both sides hash the same thing."""
    # ensure_ascii would escape the Urdu in the company tagline to \uXXXX while
    # JavaScript emits it raw, and the two sides would hash it differently.
    return json.dumps(normalise(payload), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def digest(payload):
    return hashlib.sha1(canonical(payload).encode()).hexdigest()


def uid_of(conn, table, row_id, cache):
    if row_id is None:
        return None
    hit = cache.get((table, row_id))
    if hit:
        return hit
    row = conn.execute(f"SELECT uid FROM {table} WHERE id = ?", (row_id,)).fetchone()
    value = row["uid"] if row and row["uid"] else None
    cache[(table, row_id)] = value
    return value


def id_of(conn, table, uid):
    if not uid:
        return None
    row = conn.execute(f"SELECT id FROM {table} WHERE uid = ?", (uid,)).fetchone()
    return row["id"] if row else None


def read_aggregate(conn, entity, row, cache):
    """One record as it travels: its own columns, references as uids, its lines."""
    fields = {k: v for k, v in dict(row).items() if k not in NEVER_TRAVELS}
    for column, target in REFERENCES.get(entity, {}).items():
        fields.pop(column, None)
        fields[f"{column}__uid"] = uid_of(conn, target, row[column], cache)

    lines = []
    if entity in CHILDREN:
        table, parent, refs = CHILDREN[entity]
        for child in conn.execute(
                f"SELECT * FROM {table} WHERE {parent} = ? ORDER BY id", (row["id"],)).fetchall():
            line = {k: v for k, v in dict(child).items() if k not in ("id", parent)}
            for column, target in refs.items():
                line.pop(column, None)
                line[f"{column}__uid"] = uid_of(conn, target, child[column], cache)
            lines.append(line)
    return {"fields": fields, "lines": lines}


def snapshot(conn):
    """Every travelling row, keyed by entity and uid, with its content hash."""
    cache = {}
    out = {}
    for entity in db.SYNCED_TABLES:
        rows = {}
        for row in conn.execute(f"SELECT * FROM {entity}").fetchall():
            uid = row["uid"]
            if not uid:
                continue
            body = read_aggregate(conn, entity, row, cache)
            rows[uid] = {"body": body, "hash": digest(body),
                         "updated_at": row["updated_at"] or ""}
        out[entity] = rows
    return out


def shadow_of(conn):
    agreed = {}
    for row in conn.execute("SELECT entity, uid, hash FROM sync_shadow").fetchall():
        agreed.setdefault(row["entity"], {})[row["uid"]] = row["hash"]
    return agreed


def local_changes(conn, current, agreed):
    """What differs here from what the two sides last agreed on."""
    stamp = now()
    changes = []
    for entity, rows in current.items():
        known = agreed.get(entity, {})
        for uid, record in rows.items():
            if known.get(uid) == record["hash"]:
                continue
            # The row differs from what was last agreed, so it changed since
            # then and the stamp has to move with it. Setting it only once - as
            # this did - meant the stamp recorded when a row was first shared,
            # not when it last changed, and "the newer one wins" quietly became
            # "whoever shared it first wins".
            record["updated_at"] = stamp
            conn.execute(f"UPDATE {entity} SET updated_at = ? WHERE uid = ?", (stamp, uid))
            changes.append({"entity": entity, "uid": uid, "body": record["body"],
                            "hash": record["hash"], "updated_at": record["updated_at"]})
    conn.commit()
    return changes


def local_tombstones(conn, current, agreed):
    """Rows the other side has that are gone from here."""
    graves = []
    recorded = {(r["entity"], r["uid"]): r["deleted_at"] for r in
                conn.execute("SELECT entity, uid, deleted_at FROM tombstones").fetchall()}
    for entity, known in agreed.items():
        here = current.get(entity, {})
        for uid in known:
            if uid in here:
                continue
            when = recorded.get((entity, uid))
            if not when:
                when = now()
                conn.execute(
                    "INSERT INTO tombstones (entity, uid, deleted_at) VALUES (?,?,?)",
                    (entity, uid, when))
            graves.append({"entity": entity, "uid": uid, "deleted_at": when})
    conn.commit()
    return graves


def write_aggregate(conn, entity, uid, body, updated_at):
    """Create or replace one record and its lines."""
    fields = dict(body["fields"])
    for column, target in REFERENCES.get(entity, {}).items():
        fields[column] = id_of(conn, target, fields.pop(f"{column}__uid", None))

    known = set(columns_of(conn, entity))
    fields = {k: v for k, v in fields.items() if k in known}
    renamed = free_up_number(conn, entity, fields, uid)
    if renamed:
        conn.execute(
            """INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
               VALUES (?,?,?,?,?)""",
            (entity, uid, now(),
             canonical({"renumbered": renamed["now"]}),
             canonical({"arrived_as": renamed["was"],
                        "reason": "that number was already used here"})))

    existing = conn.execute(f"SELECT id FROM {entity} WHERE uid = ?", (uid,)).fetchone()
    if not existing and entity in db.SINGLETONS:
        # There is only one of these. Update the row that is already there
        # rather than filing a second one, which the table forbids anyway.
        existing = conn.execute(f"SELECT id FROM {entity} LIMIT 1").fetchone()
        if existing:
            conn.execute(f"UPDATE {entity} SET uid = ? WHERE id = ?", (uid, existing["id"]))
    if existing:
        row_id = existing["id"]
        if fields:
            assignments = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE {entity} SET {assignments}, updated_at = ? WHERE id = ?",
                         (*fields.values(), updated_at, row_id))
    else:
        names = list(fields) + ["uid", "updated_at"]
        values = list(fields.values()) + [uid, updated_at]
        placeholders = ", ".join("?" * len(names))
        cur = conn.execute(
            f"INSERT INTO {entity} ({', '.join(names)}) VALUES ({placeholders})", values)
        row_id = cur.lastrowid

    if entity in CHILDREN:
        table, parent, refs = CHILDREN[entity]
        child_columns = set(columns_of(conn, table))
        conn.execute(f"DELETE FROM {table} WHERE {parent} = ?", (row_id,))
        for line in body["lines"]:
            values = dict(line)
            for column, target in refs.items():
                values[column] = id_of(conn, target, values.pop(f"{column}__uid", None))
            values = {k: v for k, v in values.items() if k in child_columns}
            values[parent] = row_id
            placeholders = ", ".join("?" * len(values))
            conn.execute(
                f"INSERT INTO {table} ({', '.join(values)}) VALUES ({placeholders})",
                list(values.values()))
    return row_id


def remove_aggregate(conn, entity, uid, when):
    """Remove a row the other side deleted. Returns a note if it was kept."""
    row = conn.execute(f"SELECT id FROM {entity} WHERE uid = ?", (uid,)).fetchone()
    if row:
        holding = still_in_use(conn, entity, row["id"])
        if holding:
            # Deleting it would take work with it that the other machine has
            # never seen. Keep it, and say so.
            return {"entity": entity, "uid": uid, "kept_because": ", ".join(holding)}
        if entity in CHILDREN:
            table, parent, _ = CHILDREN[entity]
            conn.execute(f"DELETE FROM {table} WHERE {parent} = ?", (row["id"],))
        conn.execute(f"DELETE FROM {entity} WHERE id = ?", (row["id"],))
    conn.execute(
        "INSERT INTO tombstones (entity, uid, deleted_at) VALUES (?,?,?) "
        "ON CONFLICT (entity, uid) DO UPDATE SET deleted_at = excluded.deleted_at",
        (entity, uid, when))
    return None


# Records are applied parents-first so a reference always finds its target.
ORDER = ["company", "accounts", "customers", "suppliers", "products", "fixed_assets",
         "orders", "invoices", "purchases", "journal_entries", "field_entries",
         "stock_moves"]

# What points at a row, and would be orphaned if it went. A delete travels only
# when the other machine has nothing left depending on it: the office removing a
# customer must not take away an order the web site raised for them in the
# meantime. The row is kept and the disagreement recorded instead.
DEPENDENTS = {
    "customers": [("orders", "customer_id"), ("invoices", "customer_id")],
    "suppliers": [("purchases", "supplier_id"), ("products", "supplier_id")],
    "products": [("order_items", "product_id"), ("invoice_items", "product_id"),
                 ("purchase_items", "product_id"), ("stock_moves", "product_id")],
    "accounts": [("journal_lines", "account_id")],
    "orders": [("invoices", "order_id")],
}


def still_in_use(conn, entity, row_id):
    """What still points at this row, if anything."""
    holding = []
    for table, column in DEPENDENTS.get(entity, []):
        count = conn.execute(
            f"SELECT COUNT(*) AS c FROM {table} WHERE {column} = ?", (row_id,)).fetchone()["c"]
        if count:
            holding.append(f"{count} in {table}")
    return holding


def apply_incoming(conn, changes, graves, current, agreed):
    """Merge what the other side sent. Returns the conflicts that were logged."""
    # A laptop whose date is wrong would otherwise look newer than everything
    # for ever and win every disagreement from now on, quietly overriding work
    # done elsewhere. No machine gets to claim a change from the future.
    ceiling = now()
    for change in changes:
        if (change.get("updated_at") or "") > ceiling:
            change["updated_at"] = ceiling
    conflicts = []
    by_entity = {}
    for change in changes:
        by_entity.setdefault(change["entity"], []).append(change)

    # Work out what will actually be written before writing any of it.
    to_write = []
    for entity in ORDER:
        for change in by_entity.get(entity, []):
            uid = change["uid"]
            mine = current.get(entity, {}).get(uid)
            if mine and mine["hash"] == change["hash"]:
                continue                       # already the same, nothing to do

            if mine and agreed.get(entity, {}).get(uid) != mine["hash"]:
                # Both sides changed it. The newer wins; the other is kept.
                theirs_newer = (change.get("updated_at") or "") >= (mine["updated_at"] or "")
                conn.execute(
                    """INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
                       VALUES (?,?,?,?,?)""",
                    (entity, uid, now(),
                     canonical(change["body"] if theirs_newer else mine["body"]),
                     canonical(mine["body"] if theirs_newer else change["body"])))
                conflicts.append({"entity": entity, "uid": uid,
                                  "kept": "incoming" if theirs_newer else "local"})
                if not theirs_newer:
                    continue                   # ours stands, and goes back to them
            to_write.append((entity, change))

    # A row about to be replaced still holds its old number. Left in place it
    # looks like a clash with the row arriving to replace it, and the document
    # would be renumbered for nothing - ending up different on each machine.
    # Only rows that are genuinely being written are parked.
    for entity, change in to_write:
        if entity in UNIQUE_COLUMNS:
            column, _ = UNIQUE_COLUMNS[entity]
            conn.execute(f"UPDATE {entity} SET {column} = ? WHERE uid = ?",
                         (f"~pending-{change['uid'][:12]}", change["uid"]))

    for entity, change in to_write:
        write_aggregate(conn, entity, change["uid"], change["body"],
                        change.get("updated_at") or now())

    # Children first: removing a customer before the orders that point at them
    # would be refused by the database and abandon the whole exchange.
    depth = {name: index for index, name in enumerate(ORDER)}
    for grave in sorted(graves, key=lambda g: -depth.get(g["entity"], 0)):
        # A row changed here after the other side deleted it is kept, not lost.
        entity, uid = grave["entity"], grave["uid"]
        mine = current.get(entity, {}).get(uid)
        if mine and agreed.get(entity, {}).get(uid) != mine["hash"]:
            conn.execute(
                """INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
                   VALUES (?,?,?,?,?)""",
                (entity, uid, now(), canonical(mine["body"]), canonical({"deleted": True})))
            conflicts.append({"entity": entity, "uid": uid, "kept": "local"})
            continue
        kept = remove_aggregate(conn, entity, uid, grave["deleted_at"])
        if kept:
            conn.execute(
                """INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
                   VALUES (?,?,?,?,?)""",
                (entity, uid, now(),
                 canonical({"kept": "it is still being used here",
                            "used_by": kept["kept_because"]}),
                 canonical({"asked_for": "delete"})))
            conflicts.append({"entity": entity, "uid": uid, "kept": "local"})

    conn.commit()
    return conflicts


def record_agreement(conn, snap):
    """Remember what both sides now hold, so the next sync can spot a change."""
    stamp = now()
    conn.execute("DELETE FROM sync_shadow")
    for entity, rows in snap.items():
        for uid, record in rows.items():
            conn.execute(
                "INSERT INTO sync_shadow (entity, uid, hash, synced_at) VALUES (?,?,?,?)",
                (entity, uid, record["hash"], stamp))
    conn.commit()


def recount_stock(conn):
    """Stock is the sum of its movements. After a merge, work it out again so
    the figure agrees with the ledger behind it on both sides."""
    conn.execute("""
        UPDATE products SET stock = COALESCE(
            (SELECT ROUND(SUM(m.qty), 3) FROM stock_moves m WHERE m.product_id = products.id), 0)
        WHERE EXISTS (SELECT 1 FROM stock_moves m WHERE m.product_id = products.id)""")
    conn.commit()
