// Who brought the work in, and what it earned.
//
// The figures are checked against a story small enough to work out on paper:
// two bookers, known bookings, known prices and known costs.
//
//     node electron/test/booker-and-costing.js

import { freshApp, reporter } from "./harness.js";

const app = freshApp();
const r = reporter("BOOKERS AND COSTING");
const call = app.call;

// Two bookers out on the road.
//   Asif  : two bookings - one converted and invoiced, one still pending
//   Nadeem: one booking, converted and invoiced
const book = (clientId, who, shop, sku, qty, price, when) => {
  const item = call("GET", "/api/products").find((p) => p.sku === sku);
  app.db.run(
    `INSERT INTO field_entries (client_id, booker, kind, party_name, entry_date,
                                items, total, status)
     VALUES (?,?, 'Booking', ?,?,?,?, 'Pending')`,
    [clientId, who, shop, when, JSON.stringify([{ sku, qty, price }]), qty * price]);
  return item;
};

// stock to sell, bought at 6 each
const supplier = call("GET", "/api/suppliers")[0];
const item = call("GET", "/api/products").find((p) => p.sku === "00006");
call("POST", "/api/purchases", { supplier_id: supplier.id, purchase_date: "2026-08-01",
  tax: 0, items: [{ product_id: item.id, qty: 1000, price: 6 }], paid: 0 });

book("b1", "Asif", "Al-Madina Store", "00006", 100, 10, "2026-08-05");
book("b2", "Asif", "Rahim Kiryana", "00006", 40, 10, "2026-08-06");
book("b3", "Nadeem", "Bilal Store", "00006", 60, 10, "2026-08-07");

r.section("a booking remembers who took it");
const taken = call("GET", "/api/field/entries");
r.check("all three are recorded", taken.length === 3, taken.length);
r.check("Asif has two", taken.filter((e) => e.booker === "Asif").length === 2);
r.check("Nadeem has one", taken.filter((e) => e.booker === "Nadeem").length === 1);

r.section("the booker follows the order and the invoice");
const first = taken.find((e) => e.client_id === "b1");
const made = call("POST", `/api/field/entries/${first.id}/convert`);
const order = call("GET", "/api/orders").find((o) => o.order_no === made.number);
r.check("the order says Asif brought it", order.booker === "Asif", order.booker);
call("POST", `/api/orders/${order.id}/status`, { delivery_status: "Delivered" });
const inv = call("POST", `/api/orders/${order.id}/invoice`, { invoice_date: "2026-08-05" });
const invoice = call("GET", `/api/invoices/${inv.id}`).invoice;
r.check("so does the invoice it became", invoice.booker === "Asif", invoice.booker);
call("POST", `/api/invoices/${inv.id}/payment`, { amount: 400 });

const third = call("GET", "/api/field/entries").find((e) => e.client_id === "b3");
const made3 = call("POST", `/api/field/entries/${third.id}/convert`);
const order3 = call("GET", "/api/orders").find((o) => o.order_no === made3.number);
call("POST", `/api/orders/${order3.id}/status`, { delivery_status: "Delivered" });
const inv3 = call("POST", `/api/orders/${order3.id}/invoice`, { invoice_date: "2026-08-07" });

r.section("the booker report, worked out on paper");
const rep = call("GET", "/api/reports/bookers", null, { from: "2026-08-01", to: "2026-08-31" });
const asif = rep.bookers.find((b) => b.booker === "Asif");
const nadeem = rep.bookers.find((b) => b.booker === "Nadeem");
r.expect("Asif - bookings taken", asif.bookings, 2);
r.expect("Asif - still pending", asif.pending, 1);
r.expect("Asif - converted", asif.converted, 1);
r.expect("Asif - value booked (100x10 + 40x10)", asif.booked_value, 1400);
r.expect("Asif - orders raised", asif.orders, 1);
r.expect("Asif - invoiced (100 x 10)", asif.invoiced, 1000);
r.expect("Asif - collected", asif.collected, 400);
r.expect("Asif - still owed", asif.outstanding, 600);
r.expect("Nadeem - bookings taken", nadeem.bookings, 1);
r.expect("Nadeem - invoiced (60 x 10)", nadeem.invoiced, 600);
r.expect("Nadeem - collected nothing yet", nadeem.collected, 0);
r.expect("everyone together - invoiced", rep.total.invoiced, 1600);
r.expect("everyone together - bookings", rep.total.bookings, 3);
r.check("the bigger biller is listed first", rep.bookers[0].booker === "Asif",
  rep.bookers.map((b) => b.booker).join(", "));

r.section("costing, worked out on paper");
// 160 units sold at 10, bought at 6 -> revenue 1600, cost 960, profit 640
const cost = call("GET", "/api/reports/costing", null, { from: "2026-08-01", to: "2026-08-31" });
const line = cost.items.find((i) => i.sku === "00006");
r.expect("units sold", line.qty_sold, 160);
r.expect("what it cost us each", line.cost, 6);
r.expect("revenue (160 x 10)", line.revenue, 1600);
r.expect("cost of those sales (160 x 6)", line.cost_of_sales, 960);
r.expect("profit on the item", line.profit, 640);
r.expect("margin per cent", line.margin, 40);
r.expect("what one unit makes", line.unit_margin, 4);
r.expect("overall revenue", cost.summary.revenue, 1600);
r.expect("overall profit", cost.summary.profit, 640);
r.expect("overall margin", cost.summary.margin, 40);
r.expect("items that actually sold", cost.summary.items_sold, 1);

r.section("it agrees with the accounts, rather than second-guessing them");
const pl = call("GET", "/api/reports/profit-loss", null, { from: "2026-08-01", to: "2026-08-31" });
r.expect("gross profit matches the books", cost.summary.profit, pl.gross_profit);
r.expect("revenue matches the books", cost.summary.revenue, pl.total_income);

r.section("it warns about prices that would lose money");
const silly = call("GET", "/api/products").find((p) => p.sku === "00007");
call("PUT", `/api/products/${silly.id}`, { ...silly, purchase_price: 50, sale_price: 10 });
const after = call("GET", "/api/reports/costing", null, { from: "2026-08-01", to: "2026-08-31" });
r.check("an item priced below its cost is flagged",
  after.summary.sold_below_cost >= 1
  && after.sold_below_cost.some((i) => i.sku === "00007"),
  after.summary.sold_below_cost);
r.check("items with no cost recorded are counted",
  after.summary.no_cost_recorded > 0, after.summary.no_cost_recorded);

app.cleanup();
r.finish();
