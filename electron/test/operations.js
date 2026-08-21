// End-to-end checks against the desktop program's own operations.
//
// These exercise the paths a shop actually uses - buying, selling, delivering,
// invoicing, collecting - and assert the invariants that matter: stock matches
// its movement ledger, and the books balance.
//
//     node electron/test/operations.js

import { freshApp, reporter } from "./harness.js";
import { build as buildExport } from "../src/exports.js";

const app = freshApp();
const r = reporter("OPERATIONS");
const call = app.call;
const fail = app.failing;

const stockOf = (sku) => call("GET", "/api/products").find((p) => p.sku === sku).stock;
const stateOf = (sku) => call("GET", "/api/stock").find((s) => s.sku === sku).stock_state;

function booksBalance() {
  const tb = call("GET", "/api/reports/trial-balance");
  const bs = call("GET", "/api/reports/balance-sheet");
  return Math.abs(tb.total_debit - tb.total_credit) < 0.01 && bs.balances;
}

r.section("catalogue");
const products = call("GET", "/api/products");
const bySku = Object.fromEntries(products.map((p) => [p.sku, p]));
r.check("64 items seeded", products.length === 64, products.length);
r.check("descriptions verbatim", bySku["00001"].name === "ACHAR SACHET RS;10");
r.check("000049 kept distinct", "000049" in bySku && "00049" in bySku);
r.check("price read from description", bySku["00047"].sale_price === 60);
r.check("company seeded",
  call("GET", "/api/company").name === "Usman Traders & Suppliers");
r.check("chart of accounts seeded", call("GET", "/api/accounts").length >= 20);
r.check("vendor list seeded",
  call("GET", "/api/suppliers").some((s) => s.name === "REHAN AND BROTHERS"));

const cust = call("POST", "/api/customers", { name: "Rahim Kiryana Store", city: "Karachi" });
const supp = call("POST", "/api/suppliers", { name: "Al-Noor Masala Mills", city: "Multan" });
r.check("customer created", Boolean(cust.id));
r.check("supplier created", Boolean(supp.id));

const item = bySku["00006"];
call("PUT", `/api/products/${item.id}`, { ...item, reorder_level: 20 });

r.section("stock follows the transactions, with no manual step");
const base = stockOf("00006");
call("POST", "/api/purchases", { supplier_id: supp.id, purchase_date: "2026-08-01",
  items: [{ product_id: item.id, qty: 500, price: 7 }], paid: 1000, tax: 0 });
r.check("purchase raises stock", stockOf("00006") === base + 500, stockOf("00006"));
r.check("status becomes In Stock", stateOf("00006") === "In Stock");
r.check("cost price updated",
  call("GET", "/api/products").find((p) => p.sku === "00006").purchase_price === 7);

const order = call("POST", "/api/orders", { customer_id: cust.id, order_date: "2026-08-05",
  items: [{ product_id: item.id, qty: 120, price: 10 }], discount: 50, tax: 0 });
const detail = call("GET", `/api/orders/${order.id}`).order;
r.check("order total = 120*10-50", detail.total === 1150, detail.total);
r.check("placing an order does not move stock", stockOf("00006") === base + 500);
call("POST", `/api/orders/${order.id}/status`, { delivery_status: "Delivered" });
r.check("delivering lowers stock", stockOf("00006") === base + 380);
call("POST", `/api/orders/${order.id}/status`, { status: "Confirmed", delivery_status: "Packed" });
r.check("undoing delivery returns stock", stockOf("00006") === base + 500);
call("POST", `/api/orders/${order.id}/status`, { delivery_status: "Delivered" });

const inv = call("POST", `/api/orders/${order.id}/invoice`, { invoice_date: "2026-08-05" });
r.check("invoice from order", Boolean(inv.id));
r.check("re-invoicing idempotent",
  call("POST", `/api/orders/${order.id}/invoice`, {}).existing === true);
r.check("invoicing does not deduct twice", stockOf("00006") === base + 380);
call("POST", `/api/invoices/${inv.id}/payment`, { amount: 500 });
r.check("partial payment",
  call("GET", `/api/invoices/${inv.id}`).invoice.status === "Partial");
call("POST", `/api/invoices/${inv.id}/payment`, { amount: 9999 });
const paidInvoice = call("GET", `/api/invoices/${inv.id}`).invoice;
r.check("overpayment clamped and marked Paid",
  paidInvoice.paid === 1150 && paidInvoice.status === "Paid", paidInvoice.paid);

const moves = call("GET", "/api/stock/moves", null, { product_id: String(item.id) });
r.check("movement ledger sums to stock on hand",
  Math.abs(moves.reduce((t, m) => t + m.qty, 0) - stockOf("00006")) < 0.001,
  [moves.reduce((t, m) => t + m.qty, 0), stockOf("00006")]);

r.section("bookkeeping");
r.check("books balance after trading", booksBalance());
const codes = new Set(call("GET", "/api/reports/trial-balance").accounts.map((a) => a.code));
r.check("sale posted to receivables and sales", codes.has("1100") && codes.has("4000"));
r.check("cost of goods posted", codes.has("5000"));
r.check("purchase posted to payables", codes.has("2000"));
const pl = call("GET", "/api/reports/profit-loss", null, { from: "2026-08-01", to: "2026-08-31" });
r.check("gross profit = sales - cost",
  Math.abs(pl.gross_profit - (pl.total_income - pl.cost_of_sales)) < 0.01, pl.gross_profit);
const accounts = Object.fromEntries(call("GET", "/api/accounts").map((a) => [a.code, a.id]));
call("POST", "/api/journal", { entry_date: "2026-08-09", memo: "Capital", lines: [
  { account_id: accounts["1000"], debit: 5000 },
  { account_id: accounts["3000"], credit: 5000 }] });
r.check("manual entry accepted", booksBalance());
const bad = fail("POST", "/api/journal", { entry_date: "2026-08-09", memo: "Wrong", lines: [
  { account_id: accounts["1000"], debit: 100 },
  { account_id: accounts["3000"], credit: 60 }] });
r.check("unbalanced entry refused",
  bad !== null && bad.message.toLowerCase().includes("balance"), bad && bad.message);
call("POST", "/api/expenses", { amount: 250, expense_account: "6100", paid_from: "1000" });
r.check("expense recorded, books still balance", booksBalance());
r.check("account ledger drills down",
  call("GET", `/api/reports/ledger/${accounts["1000"]}`).lines.length > 0);
r.check("aging reports respond",
  "total" in call("GET", "/api/reports/aging")
  && "total" in call("GET", "/api/reports/aging", null, { kind: "payable" }));
call("POST", "/api/assets", { name: "Van", cost: 600000, life_months: 60 });
const dep = call("POST", "/api/assets/depreciate", { to: "2026-08-09" });
r.check("depreciation posts 600000/60", Math.abs(dep.total - 10000) < 0.01, dep.total);
r.check("books balance after depreciation", booksBalance());

r.section("counter sales and stock status");
const before = stockOf("00006");
const direct = call("POST", "/api/invoices", { customer_id: cust.id, invoice_date: "2026-08-06",
  items: [{ product_id: item.id, qty: 30, price: 10 }], paid: 300, tax: 0 });
r.check("counter sale deducts immediately", stockOf("00006") === before - 30);
call("DELETE", `/api/invoices/${direct.id}`);
r.check("deleting restores stock", stockOf("00006") === before);
r.check("books still balance after delete", booksBalance());
call("POST", "/api/stock/adjust", { product_id: item.id, qty: -(before - 10),
  note: "Count correction" });
r.check("status becomes Low Stock near reorder level", stateOf("00006") === "Low Stock",
  stateOf("00006"));
call("POST", "/api/stock/adjust", { product_id: item.id, qty: -10, note: "Clear out" });
r.check("status becomes Out of Stock at zero", stateOf("00006") === "Out of Stock");
r.check("zero adjustment rejected",
  fail("POST", "/api/stock/adjust", { product_id: item.id, qty: 0 }) !== null);

r.section("Excel exports");
const ctx = { db: app.db, user: { role: "admin" }, requireUser: () => {},
  requireAdmin: () => {}, loginRequired: () => false };
for (const kind of ["sales", "purchases", "inventory"]) {
  const book = buildExport(ctx, `/api/reports/${kind}/export`,
    { from: "2026-08-01", to: "2026-08-31" });
  r.check(`${kind} exports a real xlsx`,
    book.data.subarray(0, 2).toString() === "PK" && book.data.length > 2000,
    book.data.length);
}
const master = buildExport(ctx, "/api/products/export", {});
r.check("item master exports to Excel",
  master.data.subarray(0, 2).toString() === "PK" && master.data.length > 2000,
  master.data.length);

r.section("purchases, editing and field bookings");
const held = stockOf("00006");
const later = call("POST", "/api/purchases", { supplier_id: supp.id,
  purchase_date: "2026-08-09", status: "Ordered", tax: 0,
  items: [{ product_id: item.id, qty: 15, price: 7 }] });
r.check("an unreceived purchase leaves stock alone", stockOf("00006") === held);
call("POST", `/api/purchases/${later.id}/receive`);
r.check("receiving it adds the stock", stockOf("00006") === held + 15);
call("POST", `/api/purchases/${later.id}/payment`, { amount: 50 });
r.check("supplier payment recorded",
  call("GET", "/api/purchases").some((p) => p.id === later.id && p.paid === 50));
r.check("books balance after receiving and paying", booksBalance());

const edit = call("POST", "/api/orders", { customer_id: cust.id, order_date: "2026-08-09",
  tax: 0, items: [{ product_id: item.id, qty: 5, price: 10 }] });
call("PUT", `/api/orders/${edit.id}`, { customer_id: cust.id, order_date: "2026-08-09",
  tax: 0, items: [{ product_id: item.id, qty: 8, price: 12 }] });
r.check("an order can be edited",
  call("GET", `/api/orders/${edit.id}`).order.total === 96,
  call("GET", `/api/orders/${edit.id}`).order.total);
call("DELETE", `/api/orders/${edit.id}`);

// a booking captured in the field becomes a real order
app.db.run(
  `INSERT INTO field_entries (client_id, kind, party_name, entry_date, items, total, status)
   VALUES (?,?,?,?,?,?, 'Pending')`,
  ["conv-1", "Booking", "Field Convert Shop", "2026-08-10",
    JSON.stringify([{ sku: "00006", qty: 4, price: 11 }]), 44]);
const pending = call("GET", "/api/field/entries").find((e) => e.client_id === "conv-1");
const converted = call("POST", `/api/field/entries/${pending.id}/convert`);
r.check("field booking becomes an order",
  String(converted.number || "").startsWith("ORD"), converted.number);
r.check("the shop was created as a customer",
  call("GET", "/api/customers").some((c) => c.name === "Field Convert Shop"));

r.section("everything else");
r.check("health reports mode", call("GET", "/api/health").ok);
r.check("branding readable", "name" in call("GET", "/api/branding"));
const dash = call("GET", "/api/dashboard");
r.check("dashboard totals present",
  ["sales_month", "purchases_month", "receivables", "payables", "stock_value"]
    .every((k) => k in dash), Object.keys(dash).join(","));
r.check("customer account ledger",
  "invoices" in call("GET", `/api/customers/${cust.id}/ledger`));
const company = call("GET", "/api/company");
call("PUT", "/api/company", { ...company, phone: "021-99999999" });
r.check("company profile saves", call("GET", "/api/company").phone === "021-99999999");

const cash = call("GET", "/api/accounts").find((a) => a.is_cash);
const rec = call("GET", `/api/reports/reconcile/${cash.id}`);
r.check("reconciliation lists cash postings",
  "ledger_balance" in rec && rec.lines.length > 0);
call("POST", `/api/journal/lines/${rec.lines[0].id}/clear`, { cleared: true });
r.check("a line can be ticked as cleared",
  call("GET", `/api/reports/reconcile/${cash.id}`).cleared_balance !== 0);

const profit = call("GET", "/api/reports/profit-loss", null,
  { from: "2026-01-01", to: "2026-12-31" }).net_profit;
const closed = call("POST", "/api/accounting/close", { to: "2026-12-31", confirm: "CLOSE" });
r.check("year-end close sweeps the profit",
  Math.abs(closed.net_profit - profit) < 0.01, [closed.net_profit, profit]);
r.check("profit and loss resets after closing",
  Math.abs(call("GET", "/api/reports/profit-loss", null,
    { from: "2026-01-01", to: "2026-12-31" }).net_profit) < 0.01);
r.check("balance sheet still balances after closing", booksBalance());
r.check("closings are recorded", call("GET", "/api/accounting/closings").length === 1);
r.check("the same period cannot be closed twice",
  fail("POST", "/api/accounting/close", { to: "2026-12-31", confirm: "CLOSE" }) !== null);

r.section("guards");
r.check("empty order rejected",
  fail("POST", "/api/orders", { customer_id: cust.id, items: [] }) !== null);
const warn = fail("DELETE", `/api/customers/${cust.id}`);
r.check("customer delete warns first",
  warn !== null && warn.message.includes("|IMPACT|"), warn && warn.message);
const warnItem = fail("DELETE", `/api/products/${item.id}`);
r.check("item delete warns first",
  warnItem !== null && warnItem.message.includes("|IMPACT|"));
const dup = fail("POST", "/api/products", { name: "dup", sku: "00001" });
r.check("duplicate SKU rejected",
  dup !== null && dup.message.includes("already used"), dup && dup.message);
const sysAcc = call("GET", "/api/accounts").find((a) => a.system);
r.check("system account protected",
  fail("DELETE", `/api/accounts/${sysAcc.id}`) !== null);

r.section("bulk delete");
call("POST", "/api/danger/clear", { scope: "transactions", confirm: "DELETE" });
r.check("clearing transactions empties the documents",
  call("GET", "/api/orders").length === 0 && call("GET", "/api/invoices").length === 0
  && call("GET", "/api/purchases").length === 0);
r.check("but keeps the item master", call("GET", "/api/products").length === 64);
call("POST", "/api/danger/clear", { scope: "everything", confirm: "DELETE" });
r.check("clearing everything reseeds the item master",
  call("GET", "/api/products").length === 64);
r.check("bulk delete refuses without confirmation",
  fail("POST", "/api/danger/clear", { scope: "everything", confirm: "no" }) !== null);

r.section("sign-in and roles");
const staff = call("POST", "/api/users", { username: "shopkeeper", password: "shop1234",
  role: "staff" });
r.check("staff account created", Boolean(staff.id));
call("POST", "/api/login", { username: "shopkeeper", password: "shop1234" });
r.check("staff cannot edit company",
  fail("PUT", "/api/company", { name: "Hacked" }) !== null);
r.check("staff cannot manage users", fail("GET", "/api/users") !== null);
call("POST", "/api/login", { username: "admin", password: "admin123" });
r.check("bad password rejected",
  fail("POST", "/api/login", { username: "admin", password: "nope" }) !== null);
call("POST", "/api/logout");
r.check("signing out blocks the data", fail("GET", "/api/products") !== null);
call("POST", "/api/login", { username: "admin", password: "admin123" });
r.check("password change refuses a wrong current password",
  fail("POST", "/api/me/password",
    { current_password: "wrong", new_password: "abcdef" }) !== null);
call("POST", "/api/me/password",
  { current_password: "admin123", new_password: "newpass123" });
r.check("the old password stops working",
  fail("POST", "/api/login", { username: "admin", password: "admin123" }) !== null);
r.check("the new password works",
  call("POST", "/api/login", { username: "admin", password: "newpass123" })
    .user.username === "admin");

app.cleanup();
r.finish();
