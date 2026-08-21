// Checks the numbers, not just the plumbing.
//
// Runs a trading story whose every figure can be worked out on paper, then
// compares what the program reports against those hand-computed values. This is
// the same scenario the Python version was validated against, so a difference
// here means the port changed an answer.
//
//     node electron/test/figures.js

import { freshApp, reporter } from "./harness.js";

const app = freshApp();
const r = reporter("FIGURES");
const call = app.call;

//   capital introduced                                    100,000
//   buy 100 units at 50            = 5,000, pay 2,000 of it
//   sell 40 units at 80            = 3,200 less 200 discount = 3,000, collect 1,000
//   counter sale 10 units at 90    =   900, paid in full
//   rent                                                    1,500
//   van 60,000 over 60 months -> one month                  1,000
const CAPITAL = 100000, BUY_QTY = 100, BUY_COST = 50;
const SELL_QTY = 40, SELL_PRICE = 80, DISCOUNT = 200, COLLECTED = 1000;
const CASH_QTY = 10, CASH_PRICE = 90;
const SUPPLIER_PAID = 2000, RENT = 1500, VAN = 60000, LIFE = 60;

const accounts = Object.fromEntries(call("GET", "/api/accounts").map((a) => [a.code, a.id]));
const product = call("GET", "/api/products").find((p) => p.sku === "00006");
const supplier = call("POST", "/api/suppliers", { name: "Mills" }).id;
const customer = call("POST", "/api/customers", { name: "Shop" }).id;

call("POST", "/api/journal", { entry_date: "2026-03-01", memo: "Capital", lines: [
  { account_id: accounts["1000"], debit: CAPITAL },
  { account_id: accounts["3000"], credit: CAPITAL }] });
call("POST", "/api/purchases", { supplier_id: supplier, purchase_date: "2026-03-02", tax: 0,
  items: [{ product_id: product.id, qty: BUY_QTY, price: BUY_COST }], paid: SUPPLIER_PAID });
const order = call("POST", "/api/orders", { customer_id: customer, order_date: "2026-03-05",
  tax: 0, discount: DISCOUNT,
  items: [{ product_id: product.id, qty: SELL_QTY, price: SELL_PRICE }] });
call("POST", `/api/orders/${order.id}/status`, { delivery_status: "Delivered" });
const invoice = call("POST", `/api/orders/${order.id}/invoice`, { invoice_date: "2026-03-05" });
call("POST", `/api/invoices/${invoice.id}/payment`, { amount: COLLECTED });
call("POST", "/api/invoices", { customer_id: customer, invoice_date: "2026-03-07", tax: 0,
  items: [{ product_id: product.id, qty: CASH_QTY, price: CASH_PRICE }],
  paid: CASH_QTY * CASH_PRICE });
call("POST", "/api/expenses", { entry_date: "2026-03-08", amount: RENT,
  expense_account: "6100", paid_from: "1000", memo: "Rent" });
call("POST", "/api/assets", { name: "Van", purchase_date: "2026-03-01",
  cost: VAN, life_months: LIFE });
call("POST", "/api/assets/depreciate", { to: "2026-03-31" });

// ---------------------------------------------------------- what it should be
const sold = SELL_QTY + CASH_QTY;
const stockUnits = BUY_QTY - sold;
const cogs = sold * BUY_COST;
const sales = SELL_QTY * SELL_PRICE + CASH_QTY * CASH_PRICE;
const revenue = sales - DISCOUNT;
const depreciation = VAN / LIFE;
const cash = CAPITAL - SUPPLIER_PAID + COLLECTED + CASH_QTY * CASH_PRICE - RENT;
const receivable = (SELL_QTY * SELL_PRICE - DISCOUNT) - COLLECTED;
const payable = BUY_QTY * BUY_COST - SUPPLIER_PAID;
const inventoryValue = stockUnits * BUY_COST;
const gross = revenue - cogs;
const net = gross - RENT - depreciation;
const assets = cash + receivable + inventoryValue - depreciation;  // van at cost less depreciation
const equity = CAPITAL + net;

r.section("INVENTORY");
const live = call("GET", "/api/products").find((p) => p.sku === "00006");
r.expect("units in stock", live.stock, stockUnits);
const stockRow = call("GET", "/api/stock").find((s) => s.sku === "00006");
r.expect("stock valued at cost", stockRow.stock_value, inventoryValue);
const moves = call("GET", "/api/stock/moves", null, { product_id: String(product.id) });
r.expect("movements add up to stock", moves.reduce((t, m) => t + m.qty, 0), stockUnits);
r.expect("inventory report total value",
  call("GET", "/api/reports/inventory").summary.cost_value, inventoryValue);

r.section("SALES AND MONEY OWED");
const one = call("GET", `/api/invoices/${invoice.id}`).invoice;
r.expect("invoice subtotal", one.subtotal, SELL_QTY * SELL_PRICE);
r.expect("invoice total after discount", one.total, SELL_QTY * SELL_PRICE - DISCOUNT);
r.expect("invoice balance owing", one.total - one.paid, receivable);
r.expect("aging: total owed to us", call("GET", "/api/reports/aging").total, receivable);
r.expect("aging: total we owe",
  call("GET", "/api/reports/aging", null, { kind: "payable" }).total, payable);
r.expect("sales report gross",
  call("GET", "/api/reports/sales", null, { from: "2026-03-01", to: "2026-03-31" }).summary.total,
  (SELL_QTY * SELL_PRICE - DISCOUNT) + CASH_QTY * CASH_PRICE);

r.section("PROFIT AND LOSS");
const pl = call("GET", "/api/reports/profit-loss", null, { from: "2026-03-01", to: "2026-03-31" });
r.expect("revenue after discounts", pl.total_income, revenue);
r.expect("cost of goods sold", pl.cost_of_sales, cogs);
r.expect("gross profit", pl.gross_profit, gross);
r.expect("operating expenses", pl.operating_expenses, RENT + depreciation);
r.expect("net profit", pl.net_profit, net);

r.section("BALANCE SHEET");
const bs = call("GET", "/api/reports/balance-sheet", null, { to: "2026-03-31" });
const byCode = Object.fromEntries(
  [...bs.assets, ...bs.liabilities, ...bs.equity].map((a) => [a.code, a.amount]));
r.expect("cash in hand", byCode["1000"] || 0, cash);
r.expect("accounts receivable", byCode["1100"] || 0, receivable);
r.expect("inventory", byCode["1200"] || 0, inventoryValue);
r.expect("accounts payable", byCode["2000"] || 0, payable);
r.expect("accumulated depreciation", byCode["1590"] || 0, -depreciation);
r.expect("total assets", bs.total_assets, assets);
r.expect("total liabilities", bs.total_liabilities, payable);
r.expect("total equity", bs.total_equity, equity);
r.expect("assets = liabilities + equity", bs.total_assets,
  bs.total_liabilities + bs.total_equity);

r.section("TRIAL BALANCE");
const tb = call("GET", "/api/reports/trial-balance");
r.expect("debits equal credits", tb.total_debit, tb.total_credit);

app.cleanup();
r.finish();
