// A day in the shop, run against the program exactly as the shop will use it.
//
// The other suites prove the arithmetic and the plumbing. This one walks the
// path a person actually takes - buy from a vendor, take an order, deliver it,
// invoice it, collect half, then look at the figures - and opens every screen
// there is, so a screen that throws is caught before anyone opens it.
//
//     node electron/test/a-day-in-the-shop.js

import { freshApp, reporter } from "./harness.js";
const app = freshApp(); const r = reporter("A DAY IN THE SHOP"); const call = app.call;

r.section("he opens the program");
r.check("his 64 items are there", call("GET", "/api/products").length === 64);
r.check("his 5 vendors are there", call("GET", "/api/suppliers").length === 5);
r.check("the dashboard opens", "stock_value" in call("GET", "/api/dashboard"));

r.section("he buys stock from REHAN AND BROTHERS");
const rehan = call("GET", "/api/suppliers").find(s => s.name === "REHAN AND BROTHERS");
const achar = call("GET", "/api/products").find(p => p.sku === "00001");
const pur = call("POST", "/api/purchases", { supplier_id: rehan.id, purchase_date: "2026-08-22",
  bill_no: "B-2211", tax: 0, items: [{ product_id: achar.id, qty: 500, price: 7 }], paid: 2000 });
r.check("the purchase is saved", Boolean(pur.purchase_no), pur.purchase_no);
r.check("stock went up to 500",
  call("GET", "/api/products").find(p => p.sku === "00001").stock === 500);
r.check("he still owes 1500",
  call("GET", "/api/purchases")[0].balance === 1500, call("GET", "/api/purchases")[0].balance);

r.section("a shop orders from him");
const shop = call("POST", "/api/customers", { name: "Al-Madina Store", city: "Karachi",
  phone: "0321-9876543" });
const ord = call("POST", "/api/orders", { customer_id: shop.id, order_date: "2026-08-22",
  tax: 0, items: [{ product_id: achar.id, qty: 100, price: 10 }] });
r.check("the order is saved", Boolean(ord.order_no), ord.order_no);
r.check("stock has not moved yet",
  call("GET", "/api/products").find(p => p.sku === "00001").stock === 500);

r.section("he delivers it");
call("POST", `/api/orders/${ord.id}/status`, { delivery_status: "Delivered" });
r.check("stock came down to 400",
  call("GET", "/api/products").find(p => p.sku === "00001").stock === 400);
const inv = call("POST", `/api/orders/${ord.id}/invoice`, { invoice_date: "2026-08-22" });
r.check("the invoice is made", Boolean(inv.invoice_no), inv.invoice_no);
const full = call("GET", `/api/invoices/${inv.id}`);
r.check("the invoice is for 1000", full.invoice.total === 1000, full.invoice.total);
r.check("it shows his company on it", full.company.name === "Usman Traders & Suppliers");
r.check("it has his logo on it", String(full.company.logo).startsWith("data:image"));

r.section("the shop pays half");
call("POST", `/api/invoices/${inv.id}/payment`, { amount: 500 });
const paid = call("GET", `/api/invoices/${inv.id}`).invoice;
r.check("it shows as part paid", paid.status === "Partial", paid.status);
r.check("500 is still owed", paid.total - paid.paid === 500);

r.section("he checks his figures");
const d = call("GET", "/api/dashboard");
r.check("sales this month shows 1000", d.sales_month === 1000, d.sales_month);
r.check("purchases this month shows 3500", d.purchases_month === 3500, d.purchases_month);
r.check("money owed to him shows 500", d.receivables === 500, d.receivables);
r.check("money he owes shows 1500", d.payables === 1500, d.payables);
r.check("stock value shows 400 x 7 = 2800", d.stock_value === 2800, d.stock_value);
const pl = call("GET", "/api/reports/profit-loss", null, { from: "2026-08-01", to: "2026-08-31" });
r.check("profit = 1000 sales less 700 cost = 300", pl.net_profit === 300, pl.net_profit);
const bs = call("GET", "/api/reports/balance-sheet");
r.check("the balance sheet balances", bs.balances);
const tb = call("GET", "/api/reports/trial-balance");
r.check("debits equal credits", Math.abs(tb.total_debit - tb.total_credit) < 0.01);

r.section("every screen he can click opens");
for (const [name, path, q] of [
  ["Dashboard", "/api/dashboard"], ["Orders", "/api/orders"], ["Invoices", "/api/invoices"],
  ["Purchases", "/api/purchases"], ["Products", "/api/products"], ["Customers", "/api/customers"],
  ["Suppliers", "/api/suppliers"], ["Stock", "/api/stock"], ["Stock history", "/api/stock/moves"],
  ["Field entries", "/api/field/entries"], ["Accounts", "/api/accounts"], ["Journal", "/api/journal"],
  ["Trial balance", "/api/reports/trial-balance"], ["Profit and loss", "/api/reports/profit-loss"],
  ["Balance sheet", "/api/reports/balance-sheet"], ["Owed to him", "/api/reports/aging"],
  ["He owes", "/api/reports/aging", { kind: "payable" }], ["Inventory", "/api/reports/inventory"],
  ["Sales report", "/api/reports/sales"], ["Purchase report", "/api/reports/purchases"],
  ["Assets", "/api/assets"], ["Year-end", "/api/accounting/closings"],
  ["Company", "/api/company"], ["Users", "/api/users"]]) {
  let ok = true, detail = "";
  try { const res = call("GET", path, null, q || {}); ok = res !== undefined && res !== null; }
  catch (e) { ok = false; detail = e.message; }
  r.check(`${name} opens`, ok, detail);
}
app.cleanup(); r.finish();
