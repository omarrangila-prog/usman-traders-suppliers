// The Excel workbooks the reports offer. Ported from the export handlers in
// app.py. Each returns { filename, data } - the main process then asks the
// user where to save it, which is what a desktop program should do rather than
// dropping the file into a downloads folder.

import { Sheet, Column, write } from "./xlsx.js";
import { dispatch, today } from "./core.js";

function businessName(db) {
  const row = db.get("SELECT name FROM company WHERE id = 1");
  return row ? row.name : "Usman Traders";
}

function stamped(name) {
  const safe = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe}-${today()}.xlsx`;
}

const total = (list, key) => list.reduce((t, r) => t + (Number(r[key]) || 0), 0);

function salesBook(ctx, query) {
  const report = dispatch(ctx, "GET", "/api/reports/sales", null, query);
  const period = `${report.from} to ${report.to}`;
  const business = businessName(ctx.db);
  const s = report.summary;

  const overview = new Sheet("Summary", `${business} - Sales Report`, period);
  overview.columns = [new Column("Figure", 30), new Column("Amount", 18, "money")];
  overview.rows = [
    ["Invoices issued", s.invoices], ["Gross sales", s.total],
    ["Amount received", s.paid], ["Outstanding", s.outstanding],
    ["Discount given", s.discount], ["Tax", s.tax],
  ];

  const customers = new Sheet("By Customer", "Sales by Customer", period);
  customers.columns = [new Column("Customer", 34), new Column("Invoices", 12, "number"),
    new Column("Amount", 16, "money"), new Column("Outstanding", 16, "money")];
  customers.rows = report.by_customer.map((r) => [r.name, r.n, r.amount, r.outstanding]);
  customers.totals = ["Total", total(report.by_customer, "n"), s.total, s.outstanding];

  const items = new Sheet("By Item", "Sales by Item", period);
  items.columns = [new Column("Code", 12), new Column("Item", 40), new Column("Unit", 10),
    new Column("Qty Sold", 13, "number"), new Column("Amount", 16, "money")];
  items.rows = report.by_product.map((r) => [r.sku, r.name, r.unit, r.qty, r.amount]);
  items.totals = ["", "Total", "", total(report.by_product, "qty"),
    total(report.by_product, "amount")];

  const daily = new Sheet("Day by Day", "Daily Sales", period);
  daily.columns = [new Column("Date", 16), new Column("Invoices", 12, "number"),
    new Column("Amount", 16, "money")];
  daily.rows = report.by_day.map((r) => [r.d, r.n, r.amount]);
  daily.totals = ["Total", total(report.by_day, "n"), total(report.by_day, "amount")];

  return { filename: stamped(`${business} Sales Report`),
    data: write([overview, customers, items, daily]) };
}

function purchasesBook(ctx, query) {
  const report = dispatch(ctx, "GET", "/api/reports/purchases", null, query);
  const period = `${report.from} to ${report.to}`;
  const business = businessName(ctx.db);
  const s = report.summary;

  const overview = new Sheet("Summary", `${business} - Purchase Report`, period);
  overview.columns = [new Column("Figure", 30), new Column("Amount", 18, "money")];
  overview.rows = [
    ["Purchases recorded", s.purchases], ["Total purchased", s.total],
    ["Paid to suppliers", s.paid], ["Still owed", s.outstanding],
  ];

  const suppliers = new Sheet("By Supplier", "Purchases by Supplier", period);
  suppliers.columns = [new Column("Supplier", 34), new Column("Bills", 12, "number"),
    new Column("Amount", 16, "money"), new Column("Outstanding", 16, "money")];
  suppliers.rows = report.by_supplier.map((r) => [r.name, r.n, r.amount, r.outstanding]);
  suppliers.totals = ["Total", total(report.by_supplier, "n"), s.total, s.outstanding];

  const items = new Sheet("By Item", "Purchases by Item", period);
  items.columns = [new Column("Code", 12), new Column("Item", 40), new Column("Unit", 10),
    new Column("Qty Bought", 14, "number"), new Column("Amount", 16, "money")];
  items.rows = report.by_product.map((r) => [r.sku, r.name, r.unit, r.qty, r.amount]);
  items.totals = ["", "Total", "", total(report.by_product, "qty"),
    total(report.by_product, "amount")];

  return { filename: stamped(`${business} Purchase Report`),
    data: write([overview, suppliers, items]) };
}

function inventoryBook(ctx) {
  const report = dispatch(ctx, "GET", "/api/reports/inventory", null, {});
  const business = businessName(ctx.db);
  const period = `As at ${today()}`;
  const s = report.summary;

  const overview = new Sheet("Summary", `${business} - Inventory Report`, period);
  overview.columns = [new Column("Figure", 30), new Column("Value", 18, "money")];
  overview.rows = [
    ["Active items", s.products], ["Stock value at cost", s.cost_value],
    ["Value at sale price", s.retail_value], ["Items out of stock", s.out_of_stock],
    ["Items low on stock", s.low_stock],
  ];

  const categories = new Sheet("By Category", "Stock by Category", period);
  categories.columns = [new Column("Category", 28), new Column("Items", 10, "number"),
    new Column("Total Qty", 14, "number"), new Column("Value at Cost", 18, "money")];
  categories.rows = report.by_category.map((r) => [r.category, r.n, r.qty, r.cost_value]);
  categories.totals = ["Total", total(report.by_category, "n"),
    total(report.by_category, "qty"), s.cost_value];

  const stock = new Sheet("Stock List", "Full Stock List", period);
  stock.columns = [new Column("Code", 12), new Column("Item", 40), new Column("Category", 22),
    new Column("Unit", 10), new Column("On Hand", 12, "number"),
    new Column("Reorder At", 12, "number"), new Column("Cost", 14, "money"),
    new Column("Sale Price", 14, "money"), new Column("Stock Value", 16, "money"),
    new Column("Status", 16)];
  stock.rows = report.items.map((r) => [r.sku, r.name, r.category, r.unit, r.stock,
    r.reorder_level, r.purchase_price, r.sale_price, r.stock_value, r.stock_state]);
  stock.totals = ["", "Total", "", "", "", "", "", "", s.cost_value, ""];

  return { filename: stamped(`${business} Inventory Report`),
    data: write([overview, categories, stock]) };
}

function productsBook(ctx) {
  const business = businessName(ctx.db);
  const sheet = new Sheet("Item Master", `${business} - Item Master`, `As at ${today()}`);
  sheet.columns = [new Column("Code", 12), new Column("Item Description", 42),
    new Column("Category", 22), new Column("Unit", 10), new Column("Pack Size", 14),
    new Column("Cost", 14, "money"), new Column("Sale Price", 14, "money"),
    new Column("On Hand", 12, "number"), new Column("Reorder At", 12, "number"),
    new Column("Active", 10)];
  sheet.rows = dispatch(ctx, "GET", "/api/products", null, {}).map((p) =>
    [p.sku, p.name, p.category, p.unit, p.pack_size, p.purchase_price, p.sale_price,
      p.stock, p.reorder_level, p.active ? "Yes" : "No"]);
  return { filename: stamped(`${business} Item Master`), data: write([sheet]) };
}

function bookersBook(ctx, query) {
  const report = dispatch(ctx, "GET", "/api/reports/bookers", null, query);
  const period = `${report.from} to ${report.to}`;
  const business = businessName(ctx.db);
  const t = report.total;

  const sheet = new Sheet("By Booker", `${business} - Booker Report`, period);
  sheet.columns = [new Column("Booker", 26), new Column("Bookings", 12, "number"),
    new Column("Waiting", 11, "number"), new Column("Converted", 12, "number"),
    new Column("Value Booked", 16, "money"), new Column("Orders", 11, "number"),
    new Column("Order Value", 16, "money"), new Column("Invoices", 11, "number"),
    new Column("Invoiced", 16, "money"), new Column("Collected", 16, "money"),
    new Column("Still Owed", 16, "money")];
  sheet.rows = report.bookers.map((b) => [b.booker, b.bookings, b.pending, b.converted,
    b.booked_value, b.orders, b.order_value, b.invoices, b.invoiced, b.collected,
    b.outstanding]);
  sheet.totals = ["Total", t.bookings, t.pending, t.converted, t.booked_value, t.orders,
    t.order_value, t.invoices, t.invoiced, t.collected, t.outstanding];

  return { filename: stamped(`${business} Booker Report`), data: write([sheet]) };
}

function costingBook(ctx, query) {
  const report = dispatch(ctx, "GET", "/api/reports/costing", null, query);
  const period = `${report.from} to ${report.to}`;
  const business = businessName(ctx.db);
  const s = report.summary;

  const overview = new Sheet("Summary", `${business} - Costing & Profit`, period);
  overview.columns = [new Column("Figure", 30), new Column("Amount", 18, "money")];
  overview.rows = [
    ["Sold", s.revenue], ["What it cost us", s.cost_of_sales], ["Profit", s.profit],
    ["Margin %", s.margin], ["Items that sold", s.items_sold],
    ["Priced below cost", s.sold_below_cost], ["No cost recorded", s.no_cost_recorded],
  ];

  const detail = new Sheet("Item by Item", "Costing by Item", period);
  detail.columns = [new Column("Code", 12), new Column("Item", 40), new Column("Category", 20),
    new Column("Cost", 14, "money"), new Column("Sale Price", 14, "money"),
    new Column("Per Unit", 14, "money"), new Column("Qty Sold", 13, "number"),
    new Column("Revenue", 16, "money"), new Column("Cost of Sales", 16, "money"),
    new Column("Profit", 16, "money"), new Column("Margin %", 12, "number")];
  detail.rows = report.items.map((i) => [i.sku, i.name, i.category, i.cost, i.price,
    i.unit_margin, i.qty_sold, i.revenue, i.cost_of_sales, i.profit, i.margin]);
  detail.totals = ["", "Total", "", "", "", "", "", s.revenue, s.cost_of_sales,
    s.profit, s.margin];

  const attention = new Sheet("Needs Attention", "Prices worth checking", period);
  attention.columns = [new Column("Why", 26), new Column("Code", 12), new Column("Item", 40),
    new Column("Cost", 14, "money"), new Column("Sale Price", 14, "money"),
    new Column("Per Unit", 14, "money")];
  attention.rows = [
    ...report.sold_below_cost.map((i) =>
      ["Priced below cost", i.sku, i.name, i.cost, i.price, i.unit_margin]),
    ...report.no_cost_recorded.map((i) =>
      ["No cost recorded", i.sku, i.name, i.cost, i.price, i.unit_margin]),
  ];

  return { filename: stamped(`${business} Costing Report`),
    data: write([overview, detail, attention]) };
}

const BOOKS = {
  "/api/reports/sales/export": salesBook,
  "/api/reports/purchases/export": purchasesBook,
  "/api/reports/inventory/export": inventoryBook,
  "/api/products/export": productsBook,
  "/api/reports/bookers/export": bookersBook,
  "/api/reports/costing/export": costingBook,
};

export function isExport(path) {
  return Object.prototype.hasOwnProperty.call(BOOKS, path);
}

/** Build the workbook for an export path. Returns { filename, data }. */
export function build(ctx, path, query = {}) {
  ctx.requireUser();
  return BOOKS[path](ctx, query);
}
