// Sharing this computer's books with the cloud. Mirrors sync.py.
//
// The desktop keeps its own file and works with no internet. When it does have
// a connection it calls POST /api/sync once: it sends what changed here and a
// list of everything it holds, and gets back whatever it is missing.
//
// This is the only place in the program that touches the network, and nothing
// waits on it - the books are readable and writable whether it succeeds or not.

import { createHash } from "node:crypto";
import { SYNCED_TABLES, SINGLETONS, stampUids, nextNumber } from "./database.js";

// Which foreign keys point where. These travel as the other row's uid.
const REFERENCES = {
  products: { supplier_id: "suppliers" },
  orders: { customer_id: "customers" },
  invoices: { customer_id: "customers", order_id: "orders" },
  purchases: { supplier_id: "suppliers" },
  stock_moves: { product_id: "products" },
};

// A document carries its own lines: [table, column pointing back, its references]
const CHILDREN = {
  orders: ["order_items", "order_id", { product_id: "products" }],
  invoices: ["invoice_items", "invoice_id", { product_id: "products" }],
  purchases: ["purchase_items", "purchase_id", { product_id: "products" }],
  journal_entries: ["journal_lines", "entry_id", { account_id: "accounts" }],
};

// created_at is when a row was written into *this* database. The two sides seed
// their copies of the item master at different moments, so it always differs
// and would make every seeded row look changed on both sides - turning the very
// first sync into sixty-nine conflicts over nothing. The dates that matter to
// the business - order_date, invoice_date - are ordinary columns and do travel.
const NEVER_TRAVELS = new Set(["id", "uid", "updated_at", "created_at"]);

// Columns no two rows may share. Neither machine can see the other's numbering
// while they are apart, so both reach for the same next number and the merge
// would be refused. The arriving document is given a free number instead - it
// is a different document and must not be lost or overwrite the other.
const UNIQUE_COLUMNS = {
  orders: ["order_no", "ORD"],
  invoices: ["invoice_no", "INV"],
  purchases: ["purchase_no", "PUR"],
  products: ["sku", null],
  accounts: ["code", null],
  field_entries: ["client_id", null],
};

// Records are applied parents-first so a reference always finds its target.
const ORDER = ["company", "accounts", "customers", "suppliers", "products", "fixed_assets",
  "orders", "invoices", "purchases", "journal_entries", "field_entries", "stock_moves"];

// What points at a row, and would be orphaned if it went. A delete travels only
// when this machine has nothing left depending on it: the office removing a
// customer must not take away an order the web site raised for them in the
// meantime. The row is kept and the disagreement recorded instead.
const DEPENDENTS = {
  customers: [["orders", "customer_id"], ["invoices", "customer_id"]],
  suppliers: [["purchases", "supplier_id"], ["products", "supplier_id"]],
  products: [["order_items", "product_id"], ["invoice_items", "product_id"],
    ["purchase_items", "product_id"], ["stock_moves", "product_id"]],
  accounts: [["journal_lines", "account_id"]],
  orders: [["invoices", "order_id"]],
};

/** What still points at this row, if anything. */
function stillInUse(db, entity, rowId) {
  const holding = [];
  for (const [table, column] of DEPENDENTS[entity] || []) {
    const count = db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`, [rowId]);
    if (count) holding.push(`${count} in ${table}`);
  }
  return holding;
}

export function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

/**
 * Flatten a value to text before hashing.
 *
 * JavaScript prints 3000 where Python prints 3000.0. Left alone the two sides
 * would hash the same record differently, decide every row had changed and
 * invent conflicts out of nothing. Must match normalise() in sync.py.
 */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
}

/** Sorted-key JSON with no spaces, matching json.dumps(sort_keys, separators). */
function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonical(payload) {
  return stableJson(normalise(payload));
}

export function digest(payload) {
  return createHash("sha1").update(canonical(payload)).digest("hex");
}

function columnsOf(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

function uidOf(db, table, rowId, cache) {
  if (rowId === null || rowId === undefined) return null;
  const key = `${table}:${rowId}`;
  if (key in cache) return cache[key];
  const row = db.get(`SELECT uid FROM ${table} WHERE id = ?`, [rowId]);
  cache[key] = row && row.uid ? row.uid : null;
  return cache[key];
}

function idOf(db, table, uid) {
  if (!uid) return null;
  const row = db.get(`SELECT id FROM ${table} WHERE uid = ?`, [uid]);
  return row ? row.id : null;
}

/** One record as it travels: its own columns, references as uids, its lines. */
function readAggregate(db, entity, row, cache) {
  const fields = {};
  for (const [k, v] of Object.entries(row)) if (!NEVER_TRAVELS.has(k)) fields[k] = v;
  for (const [column, target] of Object.entries(REFERENCES[entity] || {})) {
    delete fields[column];
    fields[`${column}__uid`] = uidOf(db, target, row[column], cache);
  }

  const lines = [];
  if (CHILDREN[entity]) {
    const [table, parent, refs] = CHILDREN[entity];
    for (const child of db.all(
      `SELECT * FROM ${table} WHERE ${parent} = ? ORDER BY id`, [row.id])) {
      const line = {};
      for (const [k, v] of Object.entries(child)) if (k !== "id" && k !== parent) line[k] = v;
      for (const [column, target] of Object.entries(refs)) {
        delete line[column];
        line[`${column}__uid`] = uidOf(db, target, child[column], cache);
      }
      lines.push(line);
    }
  }
  return { fields, lines };
}

/** Every travelling row, keyed by entity and uid, with its content hash. */
export function snapshot(db) {
  const cache = {};
  const out = {};
  for (const entity of SYNCED_TABLES) {
    const rows = {};
    for (const row of db.all(`SELECT * FROM ${entity}`)) {
      if (!row.uid) continue;
      const body = readAggregate(db, entity, row, cache);
      rows[row.uid] = { body, hash: digest(body), updated_at: row.updated_at || "" };
    }
    out[entity] = rows;
  }
  return out;
}

export function shadowOf(db) {
  const agreed = {};
  for (const row of db.all("SELECT entity, uid, hash FROM sync_shadow")) {
    (agreed[row.entity] ||= {})[row.uid] = row.hash;
  }
  return agreed;
}

/** What differs here from what the two sides last agreed on. */
export function localChanges(db, current, agreed) {
  const stamp = now();
  const changes = [];
  for (const [entity, rows] of Object.entries(current)) {
    const known = agreed[entity] || {};
    for (const [uid, record] of Object.entries(rows)) {
      if (known[uid] === record.hash) continue;
      // The row differs from what was last agreed, so it changed since then and
      // the stamp has to move with it. Setting it only once - as this did -
      // meant the stamp recorded when a row was first shared, not when it last
      // changed, and "the newer one wins" quietly became "whoever shared it
      // first wins".
      record.updated_at = stamp;
      db.run(`UPDATE ${entity} SET updated_at = ? WHERE uid = ?`, [stamp, uid]);
      changes.push({ entity, uid, body: record.body, hash: record.hash,
        updated_at: record.updated_at });
    }
  }
  return changes;
}

/** Rows the other side has that are gone from here. */
export function localTombstones(db, current, agreed) {
  const graves = [];
  const recorded = {};
  for (const r of db.all("SELECT entity, uid, deleted_at FROM tombstones")) {
    recorded[`${r.entity}:${r.uid}`] = r.deleted_at;
  }
  for (const [entity, known] of Object.entries(agreed)) {
    const here = current[entity] || {};
    for (const uid of Object.keys(known)) {
      if (uid in here) continue;
      let when = recorded[`${entity}:${uid}`];
      if (!when) {
        when = now();
        db.run("INSERT INTO tombstones (entity, uid, deleted_at) VALUES (?,?,?)",
          [entity, uid, when]);
      }
      graves.push({ entity, uid, deleted_at: when });
    }
  }
  return graves;
}

/** Create or replace one record and its lines. */
/** Give an arriving row its own number if the one it came with is taken. */
function freeUpNumber(db, entity, fields, uid) {
  const spec = UNIQUE_COLUMNS[entity];
  if (!spec) return null;
  const [column, prefix] = spec;
  const value = fields[column];
  if (!value) return null;
  const clash = db.get(`SELECT uid FROM ${entity} WHERE ${column} = ? AND uid <> ?`,
    [value, uid]);
  if (!clash) return null;
  if (prefix) {
    fields[column] = nextNumber(db, entity, column, prefix);
  } else {
    // A code is the business's own label, so keep it recognisable.
    let suffix = 2;
    let candidate = `${value}-${suffix}`;
    while (db.get(`SELECT 1 FROM ${entity} WHERE ${column} = ?`, [candidate])) {
      suffix += 1;
      candidate = `${value}-${suffix}`;
    }
    fields[column] = candidate;
  }
  return { column, was: value, now: fields[column] };
}

function writeAggregate(db, entity, uid, body, updatedAt) {
  const fields = { ...body.fields };
  for (const [column, target] of Object.entries(REFERENCES[entity] || {})) {
    const ref = fields[`${column}__uid`];
    delete fields[`${column}__uid`];
    fields[column] = idOf(db, target, ref);
  }
  const known = new Set(columnsOf(db, entity));
  for (const k of Object.keys(fields)) if (!known.has(k)) delete fields[k];
  const renamed = freeUpNumber(db, entity, fields, uid);
  if (renamed) {
    db.run(`INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
            VALUES (?,?,?,?,?)`,
      [entity, uid, now(), canonical({ renumbered: renamed.now }),
        canonical({ arrived_as: renamed.was,
          reason: "that number was already used here" })]);
  }

  let existing = db.get(`SELECT id FROM ${entity} WHERE uid = ?`, [uid]);
  if (!existing && SINGLETONS.has(entity)) {
    // There is only one of these. Update the row already there rather than
    // filing a second one, which the table forbids anyway.
    existing = db.get(`SELECT id FROM ${entity} LIMIT 1`);
    if (existing) db.run(`UPDATE ${entity} SET uid = ? WHERE id = ?`, [uid, existing.id]);
  }
  let rowId;
  if (existing) {
    rowId = existing.id;
    const names = Object.keys(fields);
    if (names.length) {
      db.run(`UPDATE ${entity} SET ${names.map((k) => `${k} = ?`).join(", ")}, updated_at = ? ` +
        "WHERE id = ?", [...names.map((k) => fields[k]), updatedAt, rowId]);
    }
  } else {
    const names = [...Object.keys(fields), "uid", "updated_at"];
    const values = [...Object.keys(fields).map((k) => fields[k]), uid, updatedAt];
    rowId = db.run(`INSERT INTO ${entity} (${names.join(", ")}) ` +
      `VALUES (${names.map(() => "?").join(", ")})`, values).id;
  }

  if (CHILDREN[entity]) {
    const [table, parent, refs] = CHILDREN[entity];
    const childColumns = new Set(columnsOf(db, table));
    db.run(`DELETE FROM ${table} WHERE ${parent} = ?`, [rowId]);
    for (const line of body.lines) {
      const values = { ...line };
      for (const [column, target] of Object.entries(refs)) {
        const ref = values[`${column}__uid`];
        delete values[`${column}__uid`];
        values[column] = idOf(db, target, ref);
      }
      for (const k of Object.keys(values)) if (!childColumns.has(k)) delete values[k];
      values[parent] = rowId;
      const names = Object.keys(values);
      db.run(`INSERT INTO ${table} (${names.join(", ")}) ` +
        `VALUES (${names.map(() => "?").join(", ")})`, names.map((k) => values[k]));
    }
  }
  return rowId;
}

/** Remove a row the cloud deleted. Returns a note if it had to be kept. */
function removeAggregate(db, entity, uid, when) {
  const row = db.get(`SELECT id FROM ${entity} WHERE uid = ?`, [uid]);
  if (row) {
    const holding = stillInUse(db, entity, row.id);
    if (holding.length) {
      // Deleting it would take work with it that the cloud has never seen.
      return { entity, uid, kept_because: holding.join(", ") };
    }
    if (CHILDREN[entity]) {
      const [table, parent] = CHILDREN[entity];
      db.run(`DELETE FROM ${table} WHERE ${parent} = ?`, [row.id]);
    }
    db.run(`DELETE FROM ${entity} WHERE id = ?`, [row.id]);
  }
  db.run("INSERT INTO tombstones (entity, uid, deleted_at) VALUES (?,?,?) " +
    "ON CONFLICT (entity, uid) DO UPDATE SET deleted_at = excluded.deleted_at",
    [entity, uid, when]);
  return null;
}

/** Merge what the cloud sent. Returns the conflicts that were logged. */
export function applyIncoming(db, changes, graves, current, agreed) {
  const conflicts = [];
  // No machine gets to claim a change from the future.
  const ceiling = now();
  for (const change of changes) {
    if ((change.updated_at || "") > ceiling) change.updated_at = ceiling;
  }
  const byEntity = {};
  for (const change of changes) (byEntity[change.entity] ||= []).push(change);

  // Work out what will actually be written before writing any of it.
  const toWrite = [];
  for (const entity of ORDER) {
    for (const change of byEntity[entity] || []) {
      const { uid } = change;
      const mine = (current[entity] || {})[uid];
      if (mine && mine.hash === change.hash) continue;   // already the same

      if (mine && (agreed[entity] || {})[uid] !== mine.hash) {
        // Both sides changed it. One is kept and the other written down, never
        // discarded. See the note at the top on which one that is.
        const theirsNewer = (change.updated_at || "") >= (mine.updated_at || "");
        db.run(`INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
                VALUES (?,?,?,?,?)`,
          [entity, uid, now(),
            canonical(theirsNewer ? change.body : mine.body),
            canonical(theirsNewer ? mine.body : change.body)]);
        conflicts.push({ entity, uid, kept: theirsNewer ? "cloud" : "local" });
        if (!theirsNewer) continue;                      // ours stands
      }
      toWrite.push({ entity, change });
    }
  }

  // A row about to be replaced still holds its old number. Left in place it
  // looks like a clash with the row arriving to replace it, and the document
  // would be renumbered for nothing - ending up different on each machine.
  // Only rows that are genuinely being written are parked.
  for (const { entity, change } of toWrite) {
    if (!UNIQUE_COLUMNS[entity]) continue;
    const [column] = UNIQUE_COLUMNS[entity];
    db.run(`UPDATE ${entity} SET ${column} = ? WHERE uid = ?`,
      [`~pending-${change.uid.slice(0, 12)}`, change.uid]);
  }

  for (const { entity, change } of toWrite) {
    writeAggregate(db, entity, change.uid, change.body, change.updated_at || now());
  }

  // Children first: removing a customer before the orders that point at them
  // would be refused by the database and abandon the whole exchange.
  const depth = Object.fromEntries(ORDER.map((name, index) => [name, index]));
  const ordered = [...graves].sort((a, b) => (depth[b.entity] || 0) - (depth[a.entity] || 0));
  for (const grave of ordered) {
    const { entity, uid } = grave;
    const mine = (current[entity] || {})[uid];
    if (mine && (agreed[entity] || {})[uid] !== mine.hash) {
      // Changed here after the cloud deleted it. Keep it rather than lose it.
      db.run(`INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
              VALUES (?,?,?,?,?)`,
        [entity, uid, now(), canonical(mine.body), canonical({ deleted: true })]);
      conflicts.push({ entity, uid, kept: "local" });
      continue;
    }
    const kept = removeAggregate(db, entity, uid, grave.deleted_at);
    if (kept) {
      db.run(`INSERT INTO sync_conflicts (entity, uid, noticed_at, kept, discarded)
              VALUES (?,?,?,?,?)`,
        [entity, uid, now(),
          canonical({ kept: "it is still being used here", used_by: kept.kept_because }),
          canonical({ asked_for: "delete" })]);
      conflicts.push({ entity, uid, kept: "local" });
    }
  }
  return conflicts;
}

/** Remember what both sides now hold, so the next sync can spot a change. */
export function recordAgreement(db, snap) {
  const stamp = now();
  db.run("DELETE FROM sync_shadow");
  for (const [entity, rows] of Object.entries(snap)) {
    for (const [uid, record] of Object.entries(rows)) {
      db.run("INSERT INTO sync_shadow (entity, uid, hash, synced_at) VALUES (?,?,?,?)",
        [entity, uid, record.hash, stamp]);
    }
  }
}

/** Stock is the sum of its movements. Work it out again after a merge. */
export function recountStock(db) {
  db.run(`UPDATE products SET stock = COALESCE(
            (SELECT ROUND(SUM(m.qty), 3) FROM stock_moves m WHERE m.product_id = products.id), 0)
          WHERE EXISTS (SELECT 1 FROM stock_moves m WHERE m.product_id = products.id)`);
}

/** A map of everything held here, so the cloud can see what we are missing. */
export function holding(snap) {
  const out = {};
  for (const [entity, rows] of Object.entries(snap)) {
    out[entity] = Object.fromEntries(
      Object.entries(rows).map(([uid, r]) => [uid, r.hash]));
  }
  return out;
}

// ------------------------------------------------------------- the exchange

async function post(base, path, body, cookie) {
  const res = await fetch(base.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { error: raw.slice(0, 200) }; }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, payload, cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

/**
 * One exchange with the cloud.
 *
 * Everything is worked out before anything is written, and the whole merge runs
 * in a transaction, so a connection that drops halfway leaves the books exactly
 * as they were rather than half-merged.
 *
 * @param {object} db      the local data file
 * @param {object} account { url, username, password }
 * @returns {Promise<object>} what moved, and any conflicts
 */
export async function exchange(db, account) {
  const { url, username, password } = account;
  if (!url) throw new Error("No cloud address has been set.");

  const signIn = await post(url, "/api/login", { username, password }, null);
  if (signIn.status !== 200) {
    throw new Error(signIn.payload.error || "The cloud refused the username or password.");
  }

  // Rows written since the last exchange have no uid yet - the handlers that
  // create them know nothing about sharing, deliberately. Give them one now, or
  // they would be invisible to the snapshot and would never travel.
  stampUids(db);

  const before = snapshot(db);
  const agreed = shadowOf(db);
  const changes = localChanges(db, before, agreed);
  const graves = localTombstones(db, before, agreed);

  const reply = await post(url, "/api/sync", {
    device: "desktop", changes, tombstones: graves, holding: holding(before),
  }, signIn.cookie);
  if (reply.status === 404 || /No API endpoint/i.test(reply.payload.error || "")) {
    // The address is right and the sign-in worked, so this is an older copy of
    // the web site that predates sharing. Rather than stop, bring in the
    // bookings - which that version can still hand over - and say what happened.
    const pulled = await pullBookings(db, account);
    return {
      ok: true, at: now(), limited: true,
      sent: 0, sent_deletions: 0, received: pulled.added, received_deletions: 0,
      conflicts: [],
      note: "The web site is running an older version that cannot share fully yet, "
        + `so only the field bookings were brought in (${pulled.added} new, `
        + `${pulled.already} already here). Nothing was sent to it.`,
    };
  }
  if (reply.status !== 200) {
    throw new Error(reply.payload.error || `The cloud answered ${reply.status}.`);
  }

  // Read the local state again: nothing has changed it, but this is the state
  // the merge and the conflict test must be measured against.
  const incoming = reply.payload.changes || [];
  const incomingGraves = reply.payload.tombstones || [];
  let conflicts = [];
  db.raw.exec("BEGIN");
  try {
    // This computer's clock may be wrong. The cloud is what every machine has
    // in common, so its time is the one they all measure against - otherwise a
    // laptop set years ahead would win every disagreement from now on.
    const cloudTime = reply.payload.at;
    if (cloudTime) {
      for (const entity of SYNCED_TABLES) {
        db.run(`UPDATE ${entity} SET updated_at = ? WHERE updated_at > ?`,
          [cloudTime, cloudTime]);
      }
    }
    conflicts = applyIncoming(db, incoming, incomingGraves, before, agreed);
    recountStock(db);
    recordAgreement(db, snapshot(db));
    db.run(`INSERT INTO sync_state (key, value) VALUES ('last_sync', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [now()]);
    db.raw.exec("COMMIT");
  } catch (err) {
    db.raw.exec("ROLLBACK");
    throw new Error(`The merge was abandoned and nothing was changed: ${err.message}`);
  }

  return {
    ok: true,
    at: now(),
    sent: changes.length,
    sent_deletions: graves.length,
    received: incoming.length,
    received_deletions: incomingGraves.length,
    conflicts: conflicts.concat(reply.payload.conflicts || []),
  };
}

/** When the books were last shared, for the interface to show. */
export function lastSync(db) {
  const row = db.get("SELECT value FROM sync_state WHERE key = 'last_sync'");
  return row ? row.value : null;
}

// ------------------------------------------------- when the web site is older
//
// Full sharing needs the web site to be running a version that knows about it.
// Until it is, the bookings your men are taking on their phones are still
// readable through the part of the web site that has always been there - so
// they can at least be brought in one way, rather than the office being blind
// to them. This asks for nothing the old site cannot answer.

async function get(base, path, cookie) {
  const res = await fetch(base.replace(/\/$/, "") + path, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const raw = await res.text();
  try { return { status: res.status, payload: raw ? JSON.parse(raw) : null }; }
  catch { return { status: res.status, payload: null }; }
}

/**
 * Bring in bookings taken in the field, without full sharing.
 *
 * client_id is generated on the phone and is unique, so a booking already here
 * is recognised and skipped - running this twice cannot produce two of the same
 * booking. Nothing is sent, and nothing here is changed or removed.
 */
export async function pullBookings(db, account) {
  const { url, username, password } = account;
  const signIn = await post(url, "/api/login", { username, password }, null);
  if (signIn.status !== 200) {
    throw new Error(signIn.payload.error || "The web site refused the username or password.");
  }
  const listed = await get(url, "/api/field/entries", signIn.cookie);
  if (listed.status !== 200 || !Array.isArray(listed.payload)) {
    throw new Error("The web site did not return the bookings.");
  }

  let added = 0;
  let already = 0;
  db.raw.exec("BEGIN");
  try {
    for (const entry of listed.payload) {
      if (!entry.client_id) continue;
      if (db.get("SELECT 1 FROM field_entries WHERE client_id = ?", [entry.client_id])) {
        already += 1;
        continue;
      }
      const items = typeof entry.items === "string"
        ? entry.items : JSON.stringify(entry.items || []);
      db.run(
        `INSERT INTO field_entries (client_id, kind, party_name, phone, city, entry_date,
                                    notes, items, total, device, captured_at, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [entry.client_id, entry.kind || "Booking", entry.party_name || "", entry.phone || "",
          entry.city || "", entry.entry_date || "", entry.notes || "", items,
          Number(entry.total) || 0, entry.device || "", entry.captured_at || "",
          // however it was marked there, it is new work here until reviewed
          entry.status === "Rejected" ? "Rejected" : "Pending"]);
      added += 1;
    }
    db.run(`INSERT INTO sync_state (key, value) VALUES ('last_pull', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [now()]);
    db.raw.exec("COMMIT");
  } catch (err) {
    db.raw.exec("ROLLBACK");
    throw new Error(`Nothing was changed: ${err.message}`);
  }
  return { added, already, total: listed.payload.length };
}
