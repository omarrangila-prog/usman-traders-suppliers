// The data store: one SQLite file, opened directly in the main process.
// No server, no port, no network - the window asks the main process over IPC
// and the main process reads the file.

import { DatabaseSync } from "node:sqlite";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SCHEMA, SCHEMA_VERSION, SEED_PRODUCTS, SEED_SUPPLIERS, SEED_CUSTOMERS,
  CHART, PLACEHOLDER_LOGO_SVG,
} from "./seed-data.js";

let handle = null;

/** Wraps node:sqlite so the query style matches the rest of the code. */
class Db {
  constructor(raw) { this.raw = raw; }

  /** One row, or undefined. */
  get(sql, params = []) { return this.raw.prepare(sql).get(...params); }

  /** Every row. */
  all(sql, params = []) { return this.raw.prepare(sql).all(...params); }

  /** Insert/update/delete. Returns the new row id where there is one. */
  run(sql, params = []) {
    const result = this.raw.prepare(sql).run(...params);
    return { id: Number(result.lastInsertRowid), changes: Number(result.changes) };
  }

  /** First column of the first row, with a fallback when there is no row. */
  scalar(sql, params = [], fallback = 0) {
    const row = this.get(sql, params);
    if (!row) return fallback;
    const value = Object.values(row)[0];
    return value === null || value === undefined ? fallback : value;
  }

  exec(sql) { this.raw.exec(sql); }
  close() { this.raw.close(); }
}

export function hashPassword(password, salt = null) {
  const useSalt = salt || randomBytes(16).toString("hex");
  const digest = pbkdf2Sync(password, Buffer.from(useSalt, "hex"), 200000, 32, "sha256");
  return { hash: digest.toString("hex"), salt: useSalt };
}

export function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Next sequential document number, e.g. INV-0007. */
export function nextNumber(db, table, column, prefix) {
  const row = db.get(`SELECT ${column} AS n FROM ${table} ORDER BY id DESC LIMIT 1`);
  let seq = 1;
  if (row && row.n && row.n.includes("-")) {
    const tail = row.n.slice(row.n.lastIndexOf("-") + 1);
    if (/^\d+$/.test(tail)) seq = parseInt(tail, 10) + 1;
  }
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

function defaultLogo(assetDir) {
  const file = path.join(assetDir, "logo.png");
  try {
    return "data:image/png;base64," + fs.readFileSync(file).toString("base64");
  } catch {
    return "data:image/svg+xml;base64," +
      Buffer.from(PLACEHOLDER_LOGO_SVG).toString("base64");
  }
}

/** Columns added after a release has shipped need applying to existing files:
 *  CREATE TABLE IF NOT EXISTS leaves a table that already exists alone. */
function addMissingColumns(db) {
  const wanted = {
    customers: [["code", "TEXT NOT NULL DEFAULT ''"]],
    suppliers: [["code", "TEXT NOT NULL DEFAULT ''"]],
  };
  for (const [table, columns] of Object.entries(wanted)) {
    const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((r) => r.name));
    for (const [column, spec] of columns) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
    }
  }
}

function seed(db, assetDir) {
  if (db.scalar("SELECT COUNT(*) FROM company") === 0) {
    db.run(
      `INSERT INTO company (id, name, tagline, logo, address, city, phone, email,
                            currency, tax_rate, footer)
       VALUES (1, 'Usman Traders & Suppliers',
               'عثمان ٹریڈرز اینڈ سپلائرز  |  Achar • Masala • Food Items',
               ?, '', 'Karachi', '', '', 'PKR', 0, 'Thank you for your business.')`,
      [defaultLogo(assetDir)]);
  } else {
    // Replace a stand-in logo, but never one the business uploaded itself.
    const current = db.get("SELECT logo FROM company WHERE id = 1");
    if (current && (!current.logo || current.logo.startsWith("data:image/svg+xml"))) {
      db.run("UPDATE company SET logo = ? WHERE id = 1", [defaultLogo(assetDir)]);
    }
  }

  // Per row rather than only when the table is empty, so entries added in a
  // later version still reach a database already in use.
  const haveAccounts = new Set(db.all("SELECT code FROM accounts").map((r) => r.code));
  for (const a of CHART.filter((a) => !haveAccounts.has(a[0]))) {
    db.run(`INSERT INTO accounts (code, name, type, subtype, is_cash, system)
            VALUES (?,?,?,?,?,?)`, a);
  }

  if (db.scalar("SELECT COUNT(*) FROM users") === 0) {
    const { hash, salt } = hashPassword("admin123");
    db.run(`INSERT INTO users (username, full_name, role, password_hash, salt)
            VALUES (?,?,?,?,?)`, ["admin", "System Administrator", "admin", hash, salt]);
  }

  const haveSuppliers = new Set(
    db.all("SELECT code FROM suppliers WHERE code <> ''").map((r) => r.code));
  for (const v of SEED_SUPPLIERS.filter((v) => !haveSuppliers.has(v[0]))) {
    db.run(`INSERT INTO suppliers (code, name, contact, phone, email, address, city)
            VALUES (?,?,?,?,?,?,?)`, v);
  }

  if (SEED_CUSTOMERS.length && db.scalar("SELECT COUNT(*) FROM customers") === 0) {
    for (const c of SEED_CUSTOMERS) {
      db.run(`INSERT INTO customers (name, contact, phone, email, address, city)
              VALUES (?,?,?,?,?,?)`, c);
    }
  }

  if (db.scalar("SELECT COUNT(*) FROM products") === 0) {
    for (const p of SEED_PRODUCTS) {
      db.run(`INSERT INTO products (sku, name, category, unit, pack_size, purchase_price,
                                    sale_price, stock, reorder_level)
              VALUES (?,?,?,?,?,?,?,?,?)`, p);
    }
    for (const row of db.all("SELECT id, stock FROM products WHERE stock <> 0")) {
      db.run(`INSERT INTO stock_moves (product_id, kind, qty, balance, reference, note)
              VALUES (?,?,?,?,?,?)`,
        [row.id, "Opening", row.stock, row.stock, "OPENING", "Opening stock"]);
    }
  }

  db.run(`INSERT INTO settings (key, value) VALUES ('schema_version', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION]);
}

/**
 * Open the data file, building or upgrading it as needed.
 * @param {string} file     where the .db lives
 * @param {string} assetDir folder holding logo.png
 */
export function open(file, assetDir) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(new DatabaseSync(file));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  addMissingColumns(db);
  seed(db, assetDir);
  handle = db;
  return db;
}

/** Put the first-run data back after a bulk wipe, so the program stays usable. */
export function reseed(db, assetDir) {
  seed(db, assetDir);
}

export function current() {
  if (!handle) throw new Error("The data file is not open.");
  return handle;
}

export { Db, SCHEMA_VERSION };
