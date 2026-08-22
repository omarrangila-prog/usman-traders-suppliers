// Proves the desktop and the cloud can share one set of books without losing
// or duplicating anything.
//
// This is not a mock. It runs the real Python server against its own database
// and the real desktop client against its own file, and makes them talk over
// HTTP exactly as they will in the shop.
//
//     node electron/test/sharing.js

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/database.js";
import { dispatch, AppError } from "../src/core.js";
import { exchange, snapshot } from "../src/sync.js";
import { reporter } from "./harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ut-share-"));
const cloudDb = path.join(dir, "cloud.db");
const PORT = 8531 + Math.floor(Math.random() * 60);
const URL = `http://127.0.0.1:${PORT}`;
const account = { url: URL, username: "admin", password: "admin123" };

const r = reporter("SHARING");
let server;

function cloud(method, apiPath, body, cookie) {
  // curl keeps this independent of the client being tested
  const args = ["-s", "-X", method, "-H", "Content-Type: application/json"];
  if (cookie) args.push("-H", `Cookie: ${cookie}`);
  if (body !== undefined) args.push("-d", JSON.stringify(body));
  args.push(URL + apiPath);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out ? JSON.parse(out) : {};
}

let cloudCookie = "";
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
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
}

// ------------------------------------------------------------- the desktop
const desk = open(path.join(dir, "desktop.db"), path.join(ROOT, "static"));
const admin = desk.get("SELECT * FROM users WHERE username = 'admin'");
const ctx = {
  db: desk, user: admin, loginRequired: () => false,
  requireUser: () => { if (!ctx.user) throw new AppError(401, "sign in"); },
  requireAdmin: () => ctx.requireUser(),
  signIn: (u) => { ctx.user = u; }, signOut: () => { ctx.user = null; },
  refreshUser: () => {}, reseed: () => {},
};
const desktop = (method, p, body, query) => dispatch(ctx, method, p, body, query);

const countCloud = (what) => cloudCall("GET", `/api/${what}`).length;
const countDesk = (what) => desktop("GET", `/api/${what}`).length;

try {
  // Windows calls it python; everywhere else python3.
  const python = process.env.UT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  server = spawn(python, [path.join(ROOT, "app.py"), String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, UT_DB: cloudDb, UT_LOGIN: "off" },
    stdio: "ignore", detached: process.platform !== "win32",
  });
  if (!(await waitForServer())) throw new Error("the server never came up");

  r.section("two machines that have never met");
  r.check("cloud seeded its own 64 items", countCloud("products") === 64, countCloud("products"));
  r.check("desktop seeded its own 64 items", countDesk("products") === 64, countDesk("products"));

  // The whole seed-duplication trap: both sides already hold the same lists.
  let out = await exchange(desk, account);
  r.check("first sync completes", out.ok);
  r.check("meeting for the first time is not a conflict",
    out.conflicts.length === 0,
    `${out.conflicts.length} conflicts: ` +
    out.conflicts.slice(0, 3).map((c) => c.entity).join(", "));
  r.check("the item master was NOT duplicated",
    countCloud("products") === 64 && countDesk("products") === 64,
    `cloud ${countCloud("products")} / desktop ${countDesk("products")}`);
  r.check("the vendor list was NOT duplicated",
    countCloud("suppliers") === 5 && countDesk("suppliers") === 5,
    `cloud ${countCloud("suppliers")} / desktop ${countDesk("suppliers")}`);
  r.check("the chart of accounts was NOT duplicated",
    countCloud("accounts") === 20 && countDesk("accounts") === 20,
    `cloud ${countCloud("accounts")} / desktop ${countDesk("accounts")}`);

  r.section("a sync that changes nothing must move nothing");
  out = await exchange(desk, account);
  r.check("nothing is sent when nothing changed", out.sent === 0, out.sent);
  r.check("nothing is received when nothing changed", out.received === 0, out.received);
  r.check("no conflicts invented", out.conflicts.length === 0, out.conflicts);

  r.section("work done on the desktop reaches the cloud");
  const cust = desktop("POST", "/api/customers",
    { name: "Rahim Kiryana Store", city: "Karachi", phone: "0300-1112222" });
  const item = desktop("GET", "/api/products").find((p) => p.sku === "00006");
  const supp = desktop("GET", "/api/suppliers").find((s) => s.code === "00001");
  desktop("POST", "/api/purchases", { supplier_id: supp.id, purchase_date: "2026-08-10",
    tax: 0, items: [{ product_id: item.id, qty: 200, price: 6 }], paid: 0 });
  const order = desktop("POST", "/api/orders", { customer_id: cust.id, order_date: "2026-08-11",
    tax: 0, items: [{ product_id: item.id, qty: 30, price: 10 }] });
  desktop("POST", `/api/orders/${order.id}/status`, { delivery_status: "Delivered" });
  const madeInv = desktop("POST", `/api/orders/${order.id}/invoice`, { invoice_date: "2026-08-11" });

  out = await exchange(desk, account);
  r.check("the customer arrived",
    cloudCall("GET", "/api/customers").some((c) => c.name === "Rahim Kiryana Store"));
  r.check("the purchase arrived", countCloud("purchases") === 1, countCloud("purchases"));
  r.check("the order arrived", countCloud("orders") === 1, countCloud("orders"));
  r.check("the invoice arrived", countCloud("invoices") === 1, countCloud("invoices"));

  const cloudOrder = cloudCall("GET", "/api/orders")[0];
  r.check("the order kept its total", cloudOrder.total === 300, cloudOrder.total);
  r.check("the order is attached to the right customer",
    cloudOrder.customer_name === "Rahim Kiryana Store", cloudOrder.customer_name);
  const cloudItems = cloudCall("GET", `/api/orders/${cloudOrder.id}`).items;
  r.check("its line items came with it", cloudItems.length === 1 && cloudItems[0].qty === 30,
    JSON.stringify(cloudItems.map((i) => [i.sku, i.qty, i.price])));
  r.check("the line points at the same item", cloudItems[0].sku === "00006", cloudItems[0].sku);

  const cloudStock = cloudCall("GET", "/api/products").find((p) => p.sku === "00006").stock;
  const deskStock = desktop("GET", "/api/products").find((p) => p.sku === "00006").stock;
  r.check("stock agrees on both sides", cloudStock === deskStock && cloudStock === 170,
    `cloud ${cloudStock} / desktop ${deskStock}`);

  const ctb = cloudCall("GET", "/api/reports/trial-balance");
  r.check("the cloud's books balance after receiving",
    Math.abs(ctb.total_debit - ctb.total_credit) < 0.01,
    `${ctb.total_debit} vs ${ctb.total_credit}`);
  const cbs = cloudCall("GET", "/api/reports/balance-sheet");
  r.check("the cloud's balance sheet balances", cbs.balances);

  r.section("a booking taken on a phone reaches the desktop");
  cloudCall("POST", "/api/field/sync", { device: "phone-1", entries: [{
    client_id: "booking-abc", kind: "Booking", party_name: "asif store",
    phone: "03162167055", entry_date: "2026-08-12",
    items: [{ sku: "00006", qty: 4, price: 11 }] }] });
  r.check("the cloud took the booking", countCloud("field/entries") === 1);
  out = await exchange(desk, account);
  const booked = desktop("GET", "/api/field/entries");
  r.check("the booking reached the desktop", booked.length === 1, booked.length);
  r.check("with the shop's phone number",
    booked[0] && booked[0].phone === "03162167055", booked[0] && booked[0].phone);
  const conv = desktop("POST", `/api/field/entries/${booked[0].id}/convert`);
  r.check("the desktop can turn it into an order",
    String(conv.number || "").startsWith("ORD"), conv.number);

  r.section("a deletion does not come back");
  const doomed = desktop("POST", "/api/customers", { name: "Wrong Entry", city: "x" });
  await exchange(desk, account);
  r.check("it reached the cloud",
    cloudCall("GET", "/api/customers").some((c) => c.name === "Wrong Entry"));
  desktop("DELETE", `/api/customers/${doomed.id}`, null, { cascade: "1" });
  out = await exchange(desk, account);
  r.check("deleting it on the desktop removed it from the cloud",
    !cloudCall("GET", "/api/customers").some((c) => c.name === "Wrong Entry"));
  await exchange(desk, account);
  r.check("and it stays deleted after another sync",
    !desktop("GET", "/api/customers").some((c) => c.name === "Wrong Entry")
    && !cloudCall("GET", "/api/customers").some((c) => c.name === "Wrong Entry"));

  r.section("both sides edit the same record");
  const shared = desktop("GET", "/api/customers").find((c) => c.name === "Rahim Kiryana Store");
  const cloudShared = cloudCall("GET", "/api/customers").find((c) => c.name === "Rahim Kiryana Store");
  desktop("PUT", `/api/customers/${shared.id}`, { ...shared, phone: "0300-DESKTOP" });
  cloudCall("PUT", `/api/customers/${cloudShared.id}`, { ...cloudShared, phone: "0300-CLOUD" });
  out = await exchange(desk, account);
  r.check("the clash was noticed, not ignored", out.conflicts.length > 0,
    JSON.stringify(out.conflicts));
  const settled = desktop("GET", "/api/customers").find((c) => c.name === "Rahim Kiryana Store");
  const settledCloud = cloudCall("GET", "/api/customers")
    .find((c) => c.name === "Rahim Kiryana Store");
  r.check("both sides ended up with the same answer",
    settled.phone === settledCloud.phone, `desktop ${settled.phone} / cloud ${settledCloud.phone}`);
  // The losing version is written down by whichever side lost, so look at both.
  const logged = [...desk.all("SELECT * FROM sync_conflicts"),
    ...cloudCall("GET", "/api/sync/conflicts")];
  r.check("the version that lost was kept, not thrown away", logged.length > 0, logged.length);
  r.check("both versions are still readable in the log",
    logged.some((c) => (c.kept + c.discarded).includes("DESKTOP"))
    && logged.some((c) => (c.kept + c.discarded).includes("CLOUD")),
    logged.map((c) => c.discarded.slice(0, 70)).join(" | "));
  r.check("only the real clash was logged, not routine rows",
    logged.length === 1, `${logged.length} conflicts logged`);

  r.section("both sides raise a document while apart");
  // Neither machine can see the other's numbering, so both reach for the same
  // next number. The unique column would refuse the second one on merge.
  const cloudCust = cloudCall("GET", "/api/customers")[0];
  const deskCust = desktop("GET", "/api/customers")[0];
  const deskItem = desktop("GET", "/api/products").find((p) => p.sku === "00006");
  const cloudItem = cloudCall("GET", "/api/products").find((p) => p.sku === "00006");
  const deskDoc = desktop("POST", "/api/orders", { customer_id: deskCust.id,
    order_date: "2026-08-14", tax: 0,
    items: [{ product_id: deskItem.id, qty: 2, price: 50 }] });
  const cloudDoc = cloudCall("POST", "/api/orders", { customer_id: cloudCust.id,
    order_date: "2026-08-14", tax: 0,
    items: [{ product_id: cloudItem.id, qty: 3, price: 70 }] });
  r.check("they really did pick the same number",
    deskDoc.order_no === cloudDoc.order_no, `${deskDoc.order_no} / ${cloudDoc.order_no}`);

  out = await exchange(desk, account);
  r.check("the clash did not break the sync", out.ok);
  r.check("both orders survived, neither overwrote the other",
    countDesk("orders") === countCloud("orders")
    && desktop("GET", "/api/orders").some((o) => o.total === 100)
    && desktop("GET", "/api/orders").some((o) => o.total === 210),
    `desktop ${countDesk("orders")} / cloud ${countCloud("orders")}`);
  const deskNumbers = desktop("GET", "/api/orders").map((o) => o.order_no).sort();
  const cloudNumbers = cloudCall("GET", "/api/orders").map((o) => o.order_no).sort();
  r.check("every order number is unique on the desktop",
    new Set(deskNumbers).size === deskNumbers.length, deskNumbers.join(","));
  r.check("both sides show the same list of order numbers",
    deskNumbers.join(",") === cloudNumbers.join(","),
    `desktop ${deskNumbers.join(",")} / cloud ${cloudNumbers.join(",")}`);
  r.check("the two orders kept their own amounts",
    desktop("GET", "/api/orders").some((o) => o.total === 100)
    && desktop("GET", "/api/orders").some((o) => o.total === 210),
    desktop("GET", "/api/orders").map((o) => o.total).join(","));

  r.section("the books survive it all");
  await exchange(desk, account);
  const dtb = desktop("GET", "/api/reports/trial-balance");
  r.check("the desktop's books balance",
    Math.abs(dtb.total_debit - dtb.total_credit) < 0.01);
  const ftb = cloudCall("GET", "/api/reports/trial-balance");
  r.check("the cloud's books balance",
    Math.abs(ftb.total_debit - ftb.total_credit) < 0.01);
  r.check("both sides report the same trial balance",
    Math.abs(dtb.total_debit - ftb.total_debit) < 0.01,
    `desktop ${dtb.total_debit} / cloud ${ftb.total_debit}`);
  r.check("both sides hold the same number of invoices",
    countDesk("invoices") === countCloud("invoices"),
    `desktop ${countDesk("invoices")} / cloud ${countCloud("invoices")}`);
  r.check("both sides hold the same number of orders",
    countDesk("orders") === countCloud("orders"),
    `desktop ${countDesk("orders")} / cloud ${countCloud("orders")}`);
  r.check("still exactly 64 items on both sides",
    countDesk("products") === 64 && countCloud("products") === 64,
    `desktop ${countDesk("products")} / cloud ${countCloud("products")}`);

  r.section("syncing repeatedly changes nothing further");
  const a = await exchange(desk, account);
  const b = await exchange(desk, account);
  r.check("a settled pair stops exchanging",
    b.sent === 0 && b.received === 0 && b.conflicts.length === 0,
    `sent ${b.sent} received ${b.received} conflicts ${b.conflicts.length}`);
} finally {
  if (server) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
      else process.kill(-server.pid);
    } catch { /* already gone */ }
  }
  desk.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

r.finish();
