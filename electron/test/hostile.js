// Deliberately awkward situations, of the kind that only show up once two
// machines have been apart for a while and someone has tidied up on one of
// them. Every case here is one a real shop can reach without doing anything
// unusual.
//
//     node electron/test/hostile.js

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/database.js";
import { dispatch, AppError } from "../src/core.js";
import { exchange } from "../src/sync.js";
import { reporter } from "./harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ut-hostile-"));
const PORT = 8611 + Math.floor(Math.random() * 60);
const URL = `http://127.0.0.1:${PORT}`;
const account = { url: URL, username: "admin", password: "admin123" };
const r = reporter("AWKWARD SITUATIONS");
let server;

function cloudCall(method, apiPath, body) {
  const args = ["-s", "-X", method, "-H", "Content-Type: application/json",
    "-b", path.join(dir, "jar"), "-c", path.join(dir, "jar")];
  if (body !== undefined) args.push("-d", JSON.stringify(body));
  args.push(URL + apiPath);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out ? JSON.parse(out) : {};
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${URL}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
}

function desktopAt(file) {
  const db = open(file, path.join(ROOT, "static"));
  const admin = db.get("SELECT * FROM users WHERE username = 'admin'");
  const ctx = { db, user: admin, loginRequired: () => false,
    requireUser: () => { if (!ctx.user) throw new AppError(401, "sign in"); },
    requireAdmin: () => ctx.requireUser(),
    signIn: (u) => { ctx.user = u; }, signOut: () => { ctx.user = null; },
    refreshUser: () => {}, reseed: () => {} };
  return { db, call: (m, p, b, q) => dispatch(ctx, m, p, b, q) };
}

async function tryExchange(db) {
  try { return { ok: true, result: await exchange(db, account) }; }
  catch (err) { return { ok: false, error: err.message }; }
}

try {
  const python = process.env.UT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  server = spawn(python, [path.join(ROOT, "app.py"), String(PORT)], {
    cwd: ROOT, env: { ...process.env, UT_DB: path.join(dir, "cloud.db"), UT_LOGIN: "off" },
    stdio: "ignore", detached: process.platform !== "win32" });
  if (!(await waitForServer())) throw new Error("the server never came up");

  const office = desktopAt(path.join(dir, "office.db"));
  await exchange(office.db, account);

  r.section("an item is deleted here after being sold there");
  // The office tidies up an item; meanwhile a sale of it is raised on the web.
  const shop = cloudCall("POST", "/api/customers", { name: "Bilal Store", city: "Karachi" });
  const soldItem = cloudCall("GET", "/api/products").find((p) => p.sku === "00011");
  cloudCall("POST", "/api/invoices", { customer_id: shop.id, invoice_date: "2026-08-20",
    tax: 0, items: [{ product_id: soldItem.id, qty: 5, price: 12 }], paid: 0 });
  const localItem = office.call("GET", "/api/products").find((p) => p.sku === "00011");
  office.call("DELETE", `/api/products/${localItem.id}`, null, { cascade: "1" });

  let attempt = await tryExchange(office.db);
  r.check("the sync survives it", attempt.ok, attempt.error);
  r.check("the sale was not lost",
    office.call("GET", "/api/invoices").length === cloudCall("GET", "/api/invoices").length
    && cloudCall("GET", "/api/invoices").length > 0,
    `desktop ${office.call("GET", "/api/invoices").length} / ` +
    `cloud ${cloudCall("GET", "/api/invoices").length}`);
  r.check("the item it referred to is still there",
    office.call("GET", "/api/products").some((p) => p.sku === "00011"));

  r.section("a customer is deleted here with an order raised there");
  const gone = cloudCall("POST", "/api/customers", { name: "Temporary Shop", city: "x" });
  const anyItem = cloudCall("GET", "/api/products").find((p) => p.sku === "00006");
  cloudCall("POST", "/api/orders", { customer_id: gone.id, order_date: "2026-08-21",
    tax: 0, items: [{ product_id: anyItem.id, qty: 3, price: 10 }] });
  await exchange(office.db, account);
  const localGone = office.call("GET", "/api/customers").find((c) => c.name === "Temporary Shop");
  office.call("DELETE", `/api/customers/${localGone.id}`, null, { cascade: "1" });
  attempt = await tryExchange(office.db);
  r.check("the sync survives it", attempt.ok, attempt.error);
  r.check("both sides agree on how many orders there are",
    office.call("GET", "/api/orders").length === cloudCall("GET", "/api/orders").length,
    `desktop ${office.call("GET", "/api/orders").length} / ` +
    `cloud ${cloudCall("GET", "/api/orders").length}`);

  r.section("stock is cleared on one side");
  cloudCall("POST", "/api/purchases", { supplier_id:
    cloudCall("GET", "/api/suppliers")[0].id, purchase_date: "2026-08-21", tax: 0,
    items: [{ product_id: anyItem.id, qty: 90, price: 5 }], paid: 0 });
  await exchange(office.db, account);
  const before = office.call("GET", "/api/products").find((p) => p.sku === "00006").stock;
  r.check("the goods arrived on the desktop", before >= 90, before);
  office.call("DELETE", "/api/stock/moves", null, { cascade: "1" });
  attempt = await tryExchange(office.db);
  r.check("the sync survives clearing the movement history", attempt.ok, attempt.error);
  const deskStock = office.call("GET", "/api/products").find((p) => p.sku === "00006").stock;
  const cloudStock = cloudCall("GET", "/api/products").find((p) => p.sku === "00006").stock;
  r.check("stock still matches the movements behind it",
    deskStock === cloudStock, `desktop ${deskStock} / cloud ${cloudStock}`);

  r.section("a brand new computer joins a business already running");
  const newPc = desktopAt(path.join(dir, "second.db"));
  const joined = await tryExchange(newPc.db);
  r.check("it can join", joined.ok, joined.error);
  r.check("it receives the item master once, not twice",
    newPc.call("GET", "/api/products").length === 64,
    newPc.call("GET", "/api/products").length);
  r.check("it receives the orders",
    newPc.call("GET", "/api/orders").length === cloudCall("GET", "/api/orders").length,
    `${newPc.call("GET", "/api/orders").length} / ${cloudCall("GET", "/api/orders").length}`);
  r.check("it receives the invoices",
    newPc.call("GET", "/api/invoices").length === cloudCall("GET", "/api/invoices").length);
  r.check("its books balance immediately", (() => {
    const tb = newPc.call("GET", "/api/reports/trial-balance");
    return Math.abs(tb.total_debit - tb.total_credit) < 0.01;
  })());
  r.check("its stock matches the others", (() => {
    const a = newPc.call("GET", "/api/products").find((p) => p.sku === "00006").stock;
    const b = cloudCall("GET", "/api/products").find((p) => p.sku === "00006").stock;
    return a === b;
  })());

  r.section("three machines, all working at once");
  newPc.call("POST", "/api/customers", { name: "From The New Pc", city: "Karachi" });
  office.call("POST", "/api/customers", { name: "From The Office", city: "Karachi" });
  cloudCall("POST", "/api/customers", { name: "From The Web", city: "Karachi" });
  await exchange(newPc.db, account);
  await exchange(office.db, account);
  await exchange(newPc.db, account);
  const wanted = ["From The New Pc", "From The Office", "From The Web"];
  r.check("every machine ends up with all three customers",
    wanted.every((n) => office.call("GET", "/api/customers").some((c) => c.name === n))
    && wanted.every((n) => newPc.call("GET", "/api/customers").some((c) => c.name === n))
    && wanted.every((n) => cloudCall("GET", "/api/customers").some((c) => c.name === n)));
  r.check("and none of them has a duplicate",
    new Set(office.call("GET", "/api/customers").map((c) => c.name)).size
      === office.call("GET", "/api/customers").length);

  r.section("a machine with a wrong clock");
  // A laptop whose date is set years ahead would otherwise win every argument
  // for ever, because its changes always look newer.
  office.db.run("UPDATE customers SET updated_at = '2099-01-01T00:00:00' WHERE name = ?",
    ["From The Office"]);
  office.db.run("UPDATE customers SET city = 'Lahore' WHERE name = ?", ["From The Office"]);
  attempt = await tryExchange(office.db);
  r.check("the sync survives a clock set to 2099", attempt.ok, attempt.error);
  r.check("the change still reached the other side",
    cloudCall("GET", "/api/customers").find((c) => c.name === "From The Office").city === "Lahore",
    cloudCall("GET", "/api/customers").find((c) => c.name === "From The Office").city);

  // The real danger is not this one exchange. A machine stamping its work with
  // the year 2099 looks newer than everything for ever, so it would silently
  // win every disagreement from now on and the other machines' work would keep
  // losing without anyone noticing.
  r.check("the machine's future dates were pulled back to real time",
    !office.db.get("SELECT 1 AS x FROM customers WHERE updated_at > ?", ["2090-01-01"]),
    "a row is still stamped in the year 2099");

  // Now the decisive part. The web makes a genuine later change, and the office
  // makes none. If the 2099 stamp still stood, the office's stale row would
  // look newer and would overwrite the web's real work.
  const onWeb = cloudCall("GET", "/api/customers").find((c) => c.name === "From The Office");
  cloudCall("PUT", `/api/customers/${onWeb.id}`, { ...onWeb, city: "Islamabad" });
  await exchange(office.db, account);
  r.check("a genuine later change is not overridden by the wrong clock",
    cloudCall("GET", "/api/customers")
      .find((c) => c.name === "From The Office").city === "Islamabad"
    && office.call("GET", "/api/customers")
      .find((c) => c.name === "From The Office").city === "Islamabad",
    `cloud ${cloudCall("GET", "/api/customers").find((c) => c.name === "From The Office").city}` +
    ` / desktop ${office.call("GET", "/api/customers").find((c) => c.name === "From The Office").city}`);

  r.section("one change after another, the usual case");
  // The ordinary way two machines disagree: someone edits and shares, then
  // someone else edits the same thing later and shares. The later edit must win.
  const both = office.call("GET", "/api/customers").find((c) => c.name === "From The Web");
  office.call("PUT", `/api/customers/${both.id}`, { ...both, phone: "0300-FIRST" });
  await exchange(office.db, account);
  r.check("the first edit is shared",
    cloudCall("GET", "/api/customers")
      .find((c) => c.name === "From The Web").phone === "0300-FIRST");
  await new Promise((s2) => setTimeout(s2, 1100));
  const nowOnWeb = cloudCall("GET", "/api/customers").find((c) => c.name === "From The Web");
  cloudCall("PUT", `/api/customers/${nowOnWeb.id}`, { ...nowOnWeb, phone: "0300-SECOND" });
  await exchange(office.db, account);
  r.check("a later edit replaces the earlier one",
    office.call("GET", "/api/customers")
      .find((c) => c.name === "From The Web").phone === "0300-SECOND",
    office.call("GET", "/api/customers").find((c) => c.name === "From The Web").phone);

  r.section("both edited while apart, with no way to tell which came first");
  // Neither machine records the moment of an edit - only that the row differs
  // from what was last agreed. So when both are edited between the same two
  // syncs there is genuinely no way to know which came first. What must hold is
  // that the two machines agree afterwards and the other version is not lost.
  const tug = office.call("GET", "/api/customers").find((c) => c.name === "From The New Pc");
  const tugWeb = cloudCall("GET", "/api/customers").find((c) => c.name === "From The New Pc");
  office.call("PUT", `/api/customers/${tug.id}`, { ...tug, phone: "0300-OFFICE" });
  cloudCall("PUT", `/api/customers/${tugWeb.id}`, { ...tugWeb, phone: "0300-WEBSITE" });
  const conflictsBefore = (await (async () => office.db
    .scalar("SELECT COUNT(*) FROM sync_conflicts"))());
  await exchange(office.db, account);
  const settledPhone = office.call("GET", "/api/customers")
    .find((c) => c.name === "From The New Pc").phone;
  r.check("both machines settle on the same answer",
    settledPhone === cloudCall("GET", "/api/customers")
      .find((c) => c.name === "From The New Pc").phone,
    settledPhone);
  r.check("it is one of the two real values, not a mixture",
    ["0300-OFFICE", "0300-WEBSITE"].includes(settledPhone), settledPhone);
  const kept = [...office.db.all("SELECT * FROM sync_conflicts"),
    ...cloudCall("GET", "/api/sync/conflicts")];
  r.check("and the version that lost was written down, not thrown away",
    kept.some((c) => (c.kept + c.discarded).includes("0300-OFFICE"))
    && kept.some((c) => (c.kept + c.discarded).includes("0300-WEBSITE")),
    `${kept.length} recorded`);

  r.section("everything still adds up afterwards");
  await exchange(office.db, account);
  await exchange(newPc.db, account);
  const tbA = office.call("GET", "/api/reports/trial-balance");
  const tbB = cloudCall("GET", "/api/reports/trial-balance");
  const tbC = newPc.call("GET", "/api/reports/trial-balance");
  r.check("all three sets of books balance",
    [tbA, tbB, tbC].every((t) => Math.abs(t.total_debit - t.total_credit) < 0.01));
  r.check("all three report the same trial balance",
    Math.abs(tbA.total_debit - tbB.total_debit) < 0.01
    && Math.abs(tbB.total_debit - tbC.total_debit) < 0.01,
    `${tbA.total_debit} / ${tbB.total_debit} / ${tbC.total_debit}`);
  r.check("all three hold 64 items",
    office.call("GET", "/api/products").length === 64
    && newPc.call("GET", "/api/products").length === 64
    && cloudCall("GET", "/api/products").length === 64);
  const settled = await exchange(office.db, account);
  r.check("and nothing is left moving",
    settled.sent === 0 && settled.received === 0,
    `sent ${settled.sent} received ${settled.received}`);

  office.db.close();
  newPc.db.close();
} finally {
  if (server) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
      } else process.kill(-server.pid);
    } catch { /* already gone */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

r.finish();
