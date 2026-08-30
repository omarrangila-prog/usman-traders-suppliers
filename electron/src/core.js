// Every operation the program can perform. Ported from app.py.
//
// There is no HTTP here. The window calls these through IPC and they read and
// write the SQLite file directly. The shapes of the arguments and the returned
// objects match what the interface already expected, so the screens did not
// have to change.

import { nextNumber, hashPassword, verifyPassword } from "./database.js";

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Every copy of this program ships knowing the same first password. Left alone
// on a shop counter it is not a password at all, so the program insists on a
// real one before it will show the books.
const DEFAULT_PASSWORD = "admin123";

const ROUTES = [];

/** Register a handler. Groups in the pattern arrive as extra arguments. */
function route(method, pattern, fn) {
  ROUTES.push({ method, pattern: new RegExp(`^${pattern}$`), fn });
}

// -------------------------------------------------------------- small helpers

/** Round to money precision, away from zero, guarding against float dust. */
export function round2(value) {
  const n = Number(value) || 0;
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  const n = Number(value) || 0;
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 1000) / 1000;
}

/** A number from user input, or the fallback when it is not one. */
function num(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : fallback;
}

/** Trimmed text. The fallback applies only to null/undefined, matching the
 *  original: an empty string stays empty so callers can `|| default` it. */
function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

function sum(list, pick) {
  return list.reduce((t, x) => t + (pick ? pick(x) : x), 0);
}

function wantsCascade(ctx) {
  return ["1", "true", "yes"].includes(String(ctx.query.cascade || "").toLowerCase());
}

/** Refuse a delete that would take other records with it, saying what would go. */
function blocked(message, impact) {
  throw new AppError(409, `${message} |IMPACT| ${JSON.stringify(impact)}`);
}

// -------------------------------------------------------------------- access

route("POST", "/api/login", (ctx) => {
  const username = text(ctx.body.username);
  const user = ctx.db.get("SELECT * FROM users WHERE username = ? AND active = 1", [username]);
  if (!user || !verifyPassword(text(ctx.body.password), user.password_hash, user.salt)) {
    throw new AppError(401, "Invalid username or password.");
  }
  ctx.signIn(user);
  return {
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    must_change_password: verifyPassword(DEFAULT_PASSWORD, user.password_hash, user.salt),
  };
});

route("POST", "/api/logout", (ctx) => {
  ctx.signOut();
  return { ok: true };
});

route("GET", "/api/me", (ctx) => {
  ctx.requireUser();
  const u = ctx.user;
  return {
    user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role },
    must_change_password: verifyPassword(DEFAULT_PASSWORD, u.password_hash, u.salt),
  };
});

route("POST", "/api/me/password", (ctx) => {
  ctx.requireUser();
  const next = text(ctx.body.new_password);
  if (next.length < 6) throw new AppError(400, "New password must be at least 6 characters.");
  if (!verifyPassword(text(ctx.body.current_password), ctx.user.password_hash, ctx.user.salt)) {
    throw new AppError(400, "Current password is incorrect.");
  }
  const { hash, salt } = hashPassword(next);
  ctx.db.run("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", [hash, salt, ctx.user.id]);
  ctx.refreshUser();
  return { ok: true };
});

route("GET", "/api/users", (ctx) => {
  ctx.requireAdmin();
  return ctx.db.all(
    "SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id");
});

route("POST", "/api/users", (ctx) => {
  ctx.requireAdmin();
  const username = text(ctx.body.username);
  const password = text(ctx.body.password);
  if (!username || password.length < 6) {
    throw new AppError(400, "A username and a password of at least 6 characters are required.");
  }
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", [username])) {
    throw new AppError(400, "That username is already taken.");
  }
  const { hash, salt } = hashPassword(password);
  const { id } = ctx.db.run(
    `INSERT INTO users (username, full_name, role, password_hash, salt, active)
     VALUES (?,?,?,?,?,1)`,
    [username, text(ctx.body.full_name), text(ctx.body.role, "staff") || "staff", hash, salt]);
  return { id };
});

route("PUT", "/api/users/(\\d+)", (ctx, userId) => {
  ctx.requireAdmin();
  const user = ctx.db.get("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user) throw new AppError(404, "User not found.");
  ctx.db.run("UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?", [
    text(ctx.body.full_name, user.full_name),
    text(ctx.body.role, user.role) || user.role,
    ctx.body.active === undefined ? user.active : (ctx.body.active ? 1 : 0),
    userId,
  ]);
  const password = text(ctx.body.password);
  if (password) {
    if (password.length < 6) throw new AppError(400, "Password must be at least 6 characters.");
    const { hash, salt } = hashPassword(password);
    ctx.db.run("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", [hash, salt, userId]);
  }
  return { ok: true };
});

route("DELETE", "/api/users/(\\d+)", (ctx, userId) => {
  ctx.requireAdmin();
  if (Number(userId) === ctx.user.id) throw new AppError(400, "You cannot remove your own account.");
  const admins = ctx.db.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1");
  const target = ctx.db.get("SELECT * FROM users WHERE id = ?", [userId]);
  if (!target) throw new AppError(404, "User not found.");
  if (target.role === "admin" && admins <= 1) {
    throw new AppError(400, "The last administrator cannot be removed.");
  }
  ctx.db.run("DELETE FROM users WHERE id = ?", [userId]);
  return { ok: true };
});

// ------------------------------------------------------------------- company

const COMPANY_FIELDS = ["name", "tagline", "logo", "address", "city", "phone",
  "email", "website", "tax_id", "currency", "footer"];

route("GET", "/api/health", (ctx) => ({
  ok: true, time: nowIso(), storage: "sqlite-desktop",
  login_required: ctx.loginRequired(), desktop: true,
}));

route("GET", "/api/branding", (ctx) => {
  const row = ctx.db.get("SELECT name, tagline, logo FROM company WHERE id = 1") || {};
  return { ...row, demo: false, login_required: ctx.loginRequired() };
});

function companyRecord(ctx) {
  return { ...ctx.db.get("SELECT * FROM company WHERE id = 1"), demo: false,
    login_required: ctx.loginRequired() };
}

route("GET", "/api/company", (ctx) => {
  ctx.requireUser();
  return companyRecord(ctx);
});

route("PUT", "/api/company", (ctx) => {
  ctx.requireAdmin();
  const values = COMPANY_FIELDS.map((f) => text(ctx.body[f]));
  const assignments = COMPANY_FIELDS.map((f) => `${f} = ?`).join(", ");
  ctx.db.run(`UPDATE company SET ${assignments}, tax_rate = ? WHERE id = 1`,
    [...values, num(ctx.body.tax_rate)]);
  return companyRecord(ctx);
});

// ------------------------------------------------------------------ products

route("GET", "/api/products", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  const search = text(ctx.query.q);
  if (search) {
    where.push("(p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (ctx.query.category) { where.push("p.category = ?"); params.push(ctx.query.category); }
  if (ctx.query.low === "1") where.push("p.stock <= p.reorder_level");
  return ctx.db.all(
    `SELECT p.*, s.name AS supplier_name
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE ${where.join(" AND ")} ORDER BY p.name`, params);
});

function productPayload(body) {
  return [
    text(body.sku).toUpperCase(), text(body.name), text(body.category),
    text(body.unit, "pcs") || "pcs", text(body.pack_size),
    num(body.purchase_price), num(body.sale_price), num(body.reorder_level),
    body.supplier_id ? parseInt(body.supplier_id, 10) : null,
    text(body.notes), body.active === undefined || body.active ? 1 : 0,
  ];
}

route("POST", "/api/products", (ctx) => {
  ctx.requireUser();
  if (!text(ctx.body.name)) throw new AppError(400, "Product name is required.");
  const payload = productPayload(ctx.body);
  if (!payload[0]) payload[0] = nextNumber(ctx.db, "products", "sku", "SKU");
  if (ctx.db.get("SELECT 1 FROM products WHERE sku = ?", [payload[0]])) {
    throw new AppError(400, `SKU ${payload[0]} is already used by another product.`);
  }
  const opening = num(ctx.body.stock);
  const { id } = ctx.db.run(
    `INSERT INTO products (sku, name, category, unit, pack_size, purchase_price,
                           sale_price, reorder_level, supplier_id, notes, active, stock)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...payload, opening]);
  if (opening) logMove(ctx.db, id, "Opening", opening, "OPENING", "Opening stock");
  return { id };
});

route("PUT", "/api/products/(\\d+)", (ctx, productId) => {
  ctx.requireUser();
  const payload = productPayload(ctx.body);
  if (ctx.db.get("SELECT 1 FROM products WHERE sku = ? AND id <> ?", [payload[0], productId])) {
    throw new AppError(400, `SKU ${payload[0]} is already used by another product.`);
  }
  ctx.db.run(
    `UPDATE products SET sku=?, name=?, category=?, unit=?, pack_size=?, purchase_price=?,
                         sale_price=?, reorder_level=?, supplier_id=?, notes=?, active=?
     WHERE id = ?`, [...payload, productId]);
  return { ok: true };
});

route("DELETE", "/api/products/(\\d+)", (ctx, productId) => {
  ctx.requireUser();
  const counts = ctx.db.get(
    `SELECT (SELECT COUNT(*) FROM order_items WHERE product_id = ?)    AS order_lines,
            (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?)  AS invoice_lines,
            (SELECT COUNT(*) FROM purchase_items WHERE product_id = ?) AS purchase_lines,
            (SELECT COUNT(*) FROM stock_moves WHERE product_id = ?)    AS movements`,
    [productId, productId, productId, productId]);
  const used = sum(Object.values(counts));
  if (used && !wantsCascade(ctx)) blocked("This item appears on saved documents.", counts);
  if (used) {
    // Reverse the documents first so stock and totals never go stale.
    const sources = [["order_items", "order_id", purgeOrder],
      ["invoice_items", "invoice_id", purgeInvoice],
      ["purchase_items", "purchase_id", purgePurchase]];
    for (const [table, column, purge] of sources) {
      const ids = ctx.db.all(
        `SELECT DISTINCT ${column} AS docId FROM ${table} WHERE product_id = ?`, [productId]);
      for (const row of ids) purge(ctx.db, row.docId);
    }
    ctx.db.run("DELETE FROM stock_moves WHERE product_id = ?", [productId]);
  }
  ctx.db.run("DELETE FROM products WHERE id = ?", [productId]);
  return { ok: true, removed: counts };
});

// ------------------------------------------------------ customers & suppliers

const PARTY_FIELDS = ["code", "name", "contact", "phone", "email", "address",
  "city", "tax_id", "notes"];

function partyList(ctx, table) {
  ctx.requireUser();
  const search = text(ctx.query.q);
  if (search) {
    const like = `%${search}%`;
    return ctx.db.all(
      `SELECT * FROM ${table} WHERE code LIKE ? OR name LIKE ? OR contact LIKE ?
       OR phone LIKE ? OR city LIKE ? ORDER BY code, name`, [like, like, like, like, like]);
  }
  return ctx.db.all(`SELECT * FROM ${table} ORDER BY code, name`);
}

function partySave(ctx, table, partyId = null) {
  ctx.requireUser();
  if (!text(ctx.body.name)) throw new AppError(400, "Name is required.");
  const values = PARTY_FIELDS.map((f) => text(ctx.body[f]));
  const active = ctx.body.active === undefined || ctx.body.active ? 1 : 0;
  if (partyId) {
    const assignments = PARTY_FIELDS.map((f) => `${f} = ?`).join(", ");
    ctx.db.run(`UPDATE ${table} SET ${assignments}, active = ? WHERE id = ?`,
      [...values, active, partyId]);
    return { id: Number(partyId) };
  }
  const { id } = ctx.db.run(
    `INSERT INTO ${table} (${PARTY_FIELDS.join(", ")}, active)
     VALUES (${PARTY_FIELDS.map(() => "?").join(", ")}, ?)`, [...values, active]);
  return { id };
}

route("GET", "/api/customers", (ctx) => partyList(ctx, "customers"));
route("POST", "/api/customers", (ctx) => partySave(ctx, "customers"));
route("PUT", "/api/customers/(\\d+)", (ctx, id) => partySave(ctx, "customers", id));

route("DELETE", "/api/customers/(\\d+)", (ctx, customerId) => {
  ctx.requireUser();
  const counts = ctx.db.get(
    `SELECT (SELECT COUNT(*) FROM orders WHERE customer_id = ?)   AS orders,
            (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) AS invoices`,
    [customerId, customerId]);
  if (sum(Object.values(counts)) && !wantsCascade(ctx)) {
    blocked("This customer has saved documents.", counts);
  }
  for (const row of ctx.db.all(
    "SELECT id FROM invoices WHERE customer_id = ? AND order_id IS NULL", [customerId])) {
    purgeInvoice(ctx.db, row.id);
  }
  for (const row of ctx.db.all("SELECT id FROM orders WHERE customer_id = ?", [customerId])) {
    purgeOrder(ctx.db, row.id);
  }
  ctx.db.run("DELETE FROM invoices WHERE customer_id = ?", [customerId]);
  ctx.db.run("DELETE FROM customers WHERE id = ?", [customerId]);
  return { ok: true, removed: counts };
});

route("GET", "/api/customers/(\\d+)/ledger", (ctx, customerId) => {
  ctx.requireUser();
  return {
    customer: ctx.db.get("SELECT * FROM customers WHERE id = ?", [customerId]) || {},
    orders: ctx.db.all(
      "SELECT * FROM orders WHERE customer_id = ? ORDER BY order_date DESC, id DESC", [customerId]),
    invoices: ctx.db.all(
      "SELECT * FROM invoices WHERE customer_id = ? ORDER BY invoice_date DESC, id DESC",
      [customerId]),
  };
});

route("GET", "/api/suppliers", (ctx) => partyList(ctx, "suppliers"));
route("POST", "/api/suppliers", (ctx) => partySave(ctx, "suppliers"));
route("PUT", "/api/suppliers/(\\d+)", (ctx, id) => partySave(ctx, "suppliers", id));

route("DELETE", "/api/suppliers/(\\d+)", (ctx, supplierId) => {
  ctx.requireUser();
  const counts = ctx.db.get(
    `SELECT (SELECT COUNT(*) FROM purchases WHERE supplier_id = ?) AS purchases,
            (SELECT COUNT(*) FROM products WHERE supplier_id = ?)  AS linked_items`,
    [supplierId, supplierId]);
  if (sum(Object.values(counts)) && !wantsCascade(ctx)) {
    blocked("This supplier has saved documents.", counts);
  }
  for (const row of ctx.db.all("SELECT id FROM purchases WHERE supplier_id = ?", [supplierId])) {
    purgePurchase(ctx.db, row.id);
  }
  ctx.db.run("UPDATE products SET supplier_id = NULL WHERE supplier_id = ?", [supplierId]);
  ctx.db.run("DELETE FROM suppliers WHERE id = ?", [supplierId]);
  return { ok: true, removed: counts };
});

// ------------------------------------------------------------- stock helpers

/** Apply a stock delta and record it in the movement ledger. */
function logMove(db, productId, kind, qty, reference, note = "") {
  db.run("UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id = ?", [qty, productId]);
  const balance = db.get("SELECT stock FROM products WHERE id = ?", [productId]).stock;
  db.run(
    `INSERT INTO stock_moves (product_id, move_date, kind, qty, balance, reference, note)
     VALUES (?,?,?,?,?,?,?)`, [productId, nowIso(), kind, qty, balance, reference, note]);
}

/** Normalise and validate the line items posted from the interface. */
function readItems(body) {
  const items = [];
  for (const raw of body.items || []) {
    if (!raw.product_id) continue;
    const qty = num(raw.qty);
    const price = num(raw.price);
    if (qty <= 0) continue;
    items.push({ product_id: parseInt(raw.product_id, 10), qty, price,
      line_total: round2(qty * price) });
  }
  if (!items.length) {
    throw new AppError(400, "Add at least one line item with a quantity greater than zero.");
  }
  return items;
}

function totalsFrom(items, body) {
  const subtotal = round2(sum(items, (i) => i.line_total));
  const discount = num(body.discount);
  const taxRate = num(body.tax_rate);
  const tax = body.tax !== undefined && body.tax !== null
    ? num(body.tax)
    : round2((subtotal - discount) * taxRate / 100);
  return { subtotal, discount, tax, total: round2(subtotal - discount + tax) };
}

// -------------------------------------------------------------------- orders

const ORDER_STATUSES = ["Pending", "Confirmed", "Delivered", "Cancelled"];
const DELIVERY_STATUSES = ["Not Dispatched", "Packed", "Dispatched", "In Transit",
  "Delivered", "Returned"];

route("GET", "/api/orders", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  for (const [key, column] of [["status", "o.status"],
    ["delivery_status", "o.delivery_status"], ["customer_id", "o.customer_id"]]) {
    if (ctx.query[key]) { where.push(`${column} = ?`); params.push(ctx.query[key]); }
  }
  if (ctx.query.from) { where.push("o.order_date >= ?"); params.push(ctx.query.from); }
  if (ctx.query.to) { where.push("o.order_date <= ?"); params.push(ctx.query.to); }
  if (text(ctx.query.q)) {
    where.push("(o.order_no LIKE ? OR c.name LIKE ?)");
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  return ctx.db.all(
    `SELECT o.*, c.name AS customer_name, c.city AS customer_city,
            (SELECT invoice_no FROM invoices WHERE order_id = o.id LIMIT 1) AS invoice_no
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE ${where.join(" AND ")}
     ORDER BY o.order_date DESC, o.id DESC`, params);
});

route("GET", "/api/orders/(\\d+)", (ctx, orderId) => {
  ctx.requireUser();
  const order = ctx.db.get(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city,
            c.tax_id AS customer_tax_id
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]);
  if (!order) throw new AppError(404, "Order not found.");
  const items = ctx.db.all(
    `SELECT oi.*, p.name AS product_name, p.sku, p.unit
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`, [orderId]);
  const invoice = ctx.db.get("SELECT * FROM invoices WHERE order_id = ?", [orderId]);
  return { order, items, invoice: invoice || null };
});

/** direction -1 ships goods out of stock, +1 returns them. */
function applyOrderStock(db, orderId, direction) {
  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  for (const item of db.all("SELECT * FROM order_items WHERE order_id = ?", [orderId])) {
    logMove(db, item.product_id, direction < 0 ? "Sale Out" : "Sale Return",
      direction * item.qty, order.order_no,
      direction < 0 ? "Order delivered" : "Order reversed");
  }
  db.run("UPDATE orders SET stock_applied = ? WHERE id = ?",
    [direction < 0 ? 1 : 0, orderId]);
}

route("POST", "/api/orders", (ctx) => {
  ctx.requireUser();
  const body = ctx.body;
  if (!body.customer_id) throw new AppError(400, "Select a customer for this order.");
  const items = readItems(body);
  const { subtotal, discount, tax, total } = totalsFrom(items, body);
  const orderNo = nextNumber(ctx.db, "orders", "order_no", "ORD");
  const { id: orderId } = ctx.db.run(
    `INSERT INTO orders (order_no, customer_id, order_date, delivery_date, status,
                         delivery_status, tracking_note, notes, subtotal, discount, tax, total)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [orderNo, parseInt(body.customer_id, 10), text(body.order_date, today()) || today(),
      text(body.delivery_date), text(body.status, "Pending") || "Pending",
      text(body.delivery_status, "Not Dispatched") || "Not Dispatched",
      text(body.tracking_note), text(body.notes), subtotal, discount, tax, total]);
  for (const item of items) {
    ctx.db.run(
      `INSERT INTO order_items (order_id, product_id, qty, price, line_total)
       VALUES (?,?,?,?,?)`, [orderId, item.product_id, item.qty, item.price, item.line_total]);
  }
  if (text(body.status) === "Delivered") applyOrderStock(ctx.db, orderId, -1);
  return { id: orderId, order_no: orderNo };
});

route("PUT", "/api/orders/(\\d+)", (ctx, orderId) => {
  ctx.requireUser();
  const order = ctx.db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new AppError(404, "Order not found.");
  if (ctx.db.get("SELECT 1 FROM invoices WHERE order_id = ?", [orderId])) {
    throw new AppError(400, "This order is already invoiced and can no longer be edited.");
  }
  const body = ctx.body;
  const items = readItems(body);
  const { subtotal, discount, tax, total } = totalsFrom(items, body);

  if (order.stock_applied) applyOrderStock(ctx.db, orderId, +1);
  ctx.db.run("DELETE FROM order_items WHERE order_id = ?", [orderId]);
  for (const item of items) {
    ctx.db.run(
      `INSERT INTO order_items (order_id, product_id, qty, price, line_total)
       VALUES (?,?,?,?,?)`, [orderId, item.product_id, item.qty, item.price, item.line_total]);
  }
  const status = text(body.status, order.status) || order.status;
  ctx.db.run(
    `UPDATE orders SET customer_id=?, order_date=?, delivery_date=?, status=?,
                       delivery_status=?, tracking_note=?, notes=?, subtotal=?,
                       discount=?, tax=?, total=? WHERE id = ?`,
    [parseInt(body.customer_id, 10), text(body.order_date, today()) || today(),
      text(body.delivery_date), status,
      text(body.delivery_status, order.delivery_status) || order.delivery_status,
      text(body.tracking_note), text(body.notes), subtotal, discount, tax, total, orderId]);
  if (status === "Delivered") applyOrderStock(ctx.db, orderId, -1);
  return { ok: true };
});

route("POST", "/api/orders/(\\d+)/status", (ctx, orderId) => {
  ctx.requireUser();
  const order = ctx.db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new AppError(404, "Order not found.");
  let status = text(ctx.body.status, order.status) || order.status;
  const delivery = text(ctx.body.delivery_status, order.delivery_status) || order.delivery_status;
  if (!ORDER_STATUSES.includes(status)) throw new AppError(400, `Unknown order status: ${status}`);
  if (!DELIVERY_STATUSES.includes(delivery)) {
    throw new AppError(400, `Unknown delivery status: ${delivery}`);
  }
  if (delivery === "Delivered" && !["Delivered", "Cancelled"].includes(status)) {
    status = "Delivered";
  }
  ctx.db.run("UPDATE orders SET status = ?, delivery_status = ?, tracking_note = ? WHERE id = ?",
    [status, delivery, text(ctx.body.tracking_note, order.tracking_note), orderId]);
  const shouldApply = status === "Delivered";
  if (shouldApply && !order.stock_applied) {
    applyOrderStock(ctx.db, orderId, -1);
    postCogs(ctx.db, orderId);
  } else if (!shouldApply && order.stock_applied) {
    applyOrderStock(ctx.db, orderId, +1);
    unpost(ctx.db, "COGS", orderId);
  }
  return { ok: true, status, delivery_status: delivery };
});

route("DELETE", "/api/orders/(\\d+)", (ctx, orderId) => {
  ctx.requireUser();
  const order = ctx.db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new AppError(404, "Order not found.");
  const invoice = ctx.db.get("SELECT invoice_no FROM invoices WHERE order_id = ?", [orderId]);
  if (invoice && !wantsCascade(ctx)) {
    blocked("This order has been invoiced.", { invoice: invoice.invoice_no });
  }
  purgeOrder(ctx.db, orderId);
  return { ok: true };
});

// ------------------------------------------------------------------ invoices

route("GET", "/api/invoices", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  if (ctx.query.status) { where.push("i.status = ?"); params.push(ctx.query.status); }
  if (ctx.query.customer_id) { where.push("i.customer_id = ?"); params.push(ctx.query.customer_id); }
  if (ctx.query.from) { where.push("i.invoice_date >= ?"); params.push(ctx.query.from); }
  if (ctx.query.to) { where.push("i.invoice_date <= ?"); params.push(ctx.query.to); }
  if (text(ctx.query.q)) {
    where.push("(i.invoice_no LIKE ? OR c.name LIKE ?)");
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  return ctx.db.all(
    `SELECT i.*, c.name AS customer_name, o.order_no, ROUND(i.total - i.paid, 2) AS balance
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     LEFT JOIN orders o ON o.id = i.order_id
     WHERE ${where.join(" AND ")}
     ORDER BY i.invoice_date DESC, i.id DESC`, params);
});

route("GET", "/api/invoices/(\\d+)", (ctx, invoiceId) => {
  ctx.requireUser();
  const invoice = ctx.db.get(
    `SELECT i.*, c.name AS customer_name, c.contact AS customer_contact,
            c.phone AS customer_phone, c.email AS customer_email,
            c.address AS customer_address, c.city AS customer_city,
            c.tax_id AS customer_tax_id, o.order_no
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ?`, [invoiceId]);
  if (!invoice) throw new AppError(404, "Invoice not found.");
  const items = ctx.db.all(
    `SELECT ii.*, p.name AS product_name, p.sku, p.unit, p.pack_size
     FROM invoice_items ii JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id = ?`, [invoiceId]);
  const company = ctx.db.get("SELECT * FROM company WHERE id = 1");
  return { invoice, items, company };
});

function invoiceStatus(total, paid) {
  if (paid <= 0) return "Unpaid";
  return paid + 0.005 >= total ? "Paid" : "Partial";
}

route("POST", "/api/orders/(\\d+)/invoice", (ctx, orderId) => {
  ctx.requireUser();
  const order = ctx.db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new AppError(404, "Order not found.");
  if (order.status === "Cancelled") throw new AppError(400, "A cancelled order cannot be invoiced.");
  const existing = ctx.db.get("SELECT id FROM invoices WHERE order_id = ?", [orderId]);
  if (existing) return { id: existing.id, existing: true };

  const invoiceNo = nextNumber(ctx.db, "invoices", "invoice_no", "INV");
  const { id: invoiceId } = ctx.db.run(
    `INSERT INTO invoices (invoice_no, order_id, customer_id, invoice_date, due_date,
                           subtotal, discount, tax, total, paid, status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [invoiceNo, orderId, order.customer_id, text(ctx.body.invoice_date, today()) || today(),
      text(ctx.body.due_date), order.subtotal, order.discount, order.tax, order.total,
      0, "Unpaid", text(ctx.body.notes, order.notes)]);
  for (const item of ctx.db.all("SELECT * FROM order_items WHERE order_id = ?", [orderId])) {
    ctx.db.run(
      `INSERT INTO invoice_items (invoice_id, product_id, qty, price, line_total)
       VALUES (?,?,?,?,?)`, [invoiceId, item.product_id, item.qty, item.price, item.line_total]);
  }
  postInvoice(ctx.db, invoiceId);
  return { id: invoiceId, invoice_no: invoiceNo };
});

route("POST", "/api/invoices", (ctx) => {
  // Direct (counter) sale with no order behind it - deducts stock immediately.
  ctx.requireUser();
  const body = ctx.body;
  if (!body.customer_id) throw new AppError(400, "Select a customer for this invoice.");
  const items = readItems(body);
  const { subtotal, discount, tax, total } = totalsFrom(items, body);
  const paid = num(body.paid);
  const when = text(body.invoice_date, today()) || today();
  const invoiceNo = nextNumber(ctx.db, "invoices", "invoice_no", "INV");
  const { id: invoiceId } = ctx.db.run(
    `INSERT INTO invoices (invoice_no, order_id, customer_id, invoice_date, due_date,
                           subtotal, discount, tax, total, paid, status, notes)
     VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?)`,
    [invoiceNo, parseInt(body.customer_id, 10), when, text(body.due_date),
      subtotal, discount, tax, total, paid, invoiceStatus(total, paid), text(body.notes)]);
  for (const item of items) {
    ctx.db.run(
      `INSERT INTO invoice_items (invoice_id, product_id, qty, price, line_total)
       VALUES (?,?,?,?,?)`, [invoiceId, item.product_id, item.qty, item.price, item.line_total]);
    logMove(ctx.db, item.product_id, "Sale Out", -item.qty, invoiceNo, "Direct sale");
  }
  postInvoice(ctx.db, invoiceId);
  const cost = round2(sum(items, (i) =>
    num(ctx.db.get("SELECT purchase_price AS p FROM products WHERE id = ?", [i.product_id]).p)
      * i.qty));
  if (cost > 0) {
    post(ctx.db, when, `Cost of goods on ${invoiceNo}`,
      [["5000", cost, 0, invoiceNo], ["1200", 0, cost, invoiceNo]], "COGS-Invoice", invoiceId);
  }
  if (paid > 0) {
    postReceipt(ctx.db, invoiceId, paid, text(body.account, "1000") || "1000", when);
  }
  return { id: invoiceId, invoice_no: invoiceNo };
});

route("POST", "/api/invoices/(\\d+)/payment", (ctx, invoiceId) => {
  ctx.requireUser();
  const invoice = ctx.db.get("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice) throw new AppError(404, "Invoice not found.");
  const amount = num(ctx.body.amount);
  let paid = amount > 0
    ? round2(Math.min(invoice.paid + amount, invoice.total))
    : num(ctx.body.paid, invoice.paid);
  paid = Math.max(0, Math.min(paid, invoice.total));
  ctx.db.run("UPDATE invoices SET paid = ?, status = ? WHERE id = ?",
    [paid, invoiceStatus(invoice.total, paid), invoiceId]);
  const received = round2(paid - invoice.paid);
  if (received > 0) {
    postReceipt(ctx.db, invoiceId, received, text(ctx.body.account, "1000") || "1000",
      text(ctx.body.date, today()) || today());
  }
  return { paid, status: invoiceStatus(invoice.total, paid) };
});

route("DELETE", "/api/invoices/(\\d+)", (ctx, invoiceId) => {
  ctx.requireUser();
  if (!ctx.db.get("SELECT 1 FROM invoices WHERE id = ?", [invoiceId])) {
    throw new AppError(404, "Invoice not found.");
  }
  purgeInvoice(ctx.db, invoiceId);
  return { ok: true };
});

// ----------------------------------------------------------------- purchases

route("GET", "/api/purchases", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  if (ctx.query.supplier_id) { where.push("p.supplier_id = ?"); params.push(ctx.query.supplier_id); }
  if (ctx.query.from) { where.push("p.purchase_date >= ?"); params.push(ctx.query.from); }
  if (ctx.query.to) { where.push("p.purchase_date <= ?"); params.push(ctx.query.to); }
  if (text(ctx.query.q)) {
    where.push("(p.purchase_no LIKE ? OR p.bill_no LIKE ? OR s.name LIKE ?)");
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`);
  }
  return ctx.db.all(
    `SELECT p.*, s.name AS supplier_name, ROUND(p.total - p.paid, 2) AS balance
     FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.purchase_date DESC, p.id DESC`, params);
});

route("GET", "/api/purchases/(\\d+)", (ctx, purchaseId) => {
  ctx.requireUser();
  const purchase = ctx.db.get(
    `SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone,
            s.address AS supplier_address, s.city AS supplier_city
     FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`, [purchaseId]);
  if (!purchase) throw new AppError(404, "Purchase not found.");
  const items = ctx.db.all(
    `SELECT pi.*, pr.name AS product_name, pr.sku, pr.unit
     FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
     WHERE pi.purchase_id = ?`, [purchaseId]);
  return { purchase, items };
});

function applyPurchaseStock(db, purchaseId, direction) {
  const purchase = db.get("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
  for (const item of db.all("SELECT * FROM purchase_items WHERE purchase_id = ?", [purchaseId])) {
    logMove(db, item.product_id, direction > 0 ? "Purchase In" : "Purchase Return",
      direction * item.qty, purchase.purchase_no,
      direction > 0 ? "Goods received" : "Purchase reversed");
  }
  db.run("UPDATE purchases SET stock_applied = ? WHERE id = ?",
    [direction > 0 ? 1 : 0, purchaseId]);
}

route("POST", "/api/purchases", (ctx) => {
  ctx.requireUser();
  const body = ctx.body;
  if (!body.supplier_id) throw new AppError(400, "Select a supplier for this purchase.");
  const items = readItems(body);
  const { subtotal, discount, tax, total } = totalsFrom(items, body);
  const paid = num(body.paid);
  const status = text(body.status, "Received") || "Received";
  const when = text(body.purchase_date, today()) || today();
  const purchaseNo = nextNumber(ctx.db, "purchases", "purchase_no", "PUR");
  const { id: purchaseId } = ctx.db.run(
    `INSERT INTO purchases (purchase_no, supplier_id, purchase_date, bill_no, subtotal,
                            discount, tax, total, paid, status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [purchaseNo, parseInt(body.supplier_id, 10), when, text(body.bill_no),
      subtotal, discount, tax, total, paid, status, text(body.notes)]);
  for (const item of items) {
    ctx.db.run(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, price, line_total)
       VALUES (?,?,?,?,?)`, [purchaseId, item.product_id, item.qty, item.price, item.line_total]);
  }
  if (status === "Received") {
    applyPurchaseStock(ctx.db, purchaseId, +1);
    if (body.update_cost === undefined || body.update_cost) {
      for (const item of items) {
        ctx.db.run("UPDATE products SET purchase_price = ? WHERE id = ?",
          [item.price, item.product_id]);
      }
    }
  }
  postPurchase(ctx.db, purchaseId);
  if (paid > 0) {
    postSupplierPayment(ctx.db, purchaseId, paid, text(body.account, "1000") || "1000", when);
  }
  return { id: purchaseId, purchase_no: purchaseNo };
});

route("POST", "/api/purchases/(\\d+)/receive", (ctx, purchaseId) => {
  ctx.requireUser();
  const purchase = ctx.db.get("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
  if (!purchase) throw new AppError(404, "Purchase not found.");
  if (purchase.stock_applied) {
    throw new AppError(400, "This purchase has already been received into stock.");
  }
  applyPurchaseStock(ctx.db, purchaseId, +1);
  ctx.db.run("UPDATE purchases SET status = 'Received' WHERE id = ?", [purchaseId]);
  return { ok: true };
});

route("POST", "/api/purchases/(\\d+)/payment", (ctx, purchaseId) => {
  ctx.requireUser();
  const purchase = ctx.db.get("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
  if (!purchase) throw new AppError(404, "Purchase not found.");
  const amount = num(ctx.body.amount);
  const paid = Math.max(0, Math.min(purchase.paid + amount, purchase.total));
  ctx.db.run("UPDATE purchases SET paid = ? WHERE id = ?", [round2(paid), purchaseId]);
  const sent = round2(paid - purchase.paid);
  if (sent > 0) {
    postSupplierPayment(ctx.db, purchaseId, sent, text(ctx.body.account, "1000") || "1000",
      text(ctx.body.date, today()) || today());
  }
  return { paid: round2(paid) };
});

route("DELETE", "/api/purchases/(\\d+)", (ctx, purchaseId) => {
  ctx.requireUser();
  if (!ctx.db.get("SELECT 1 FROM purchases WHERE id = ?", [purchaseId])) {
    throw new AppError(404, "Purchase not found.");
  }
  purgePurchase(ctx.db, purchaseId);
  return { ok: true };
});

// ----------------------------------------------------------------- inventory

function stockOverview(ctx) {
  ctx.requireUser();
  return ctx.db.all(
    `SELECT p.id, p.sku, p.name, p.category, p.unit, p.pack_size, p.stock,
            p.reorder_level, p.purchase_price, p.sale_price,
            ROUND(p.stock * p.purchase_price, 2) AS stock_value,
            CASE WHEN p.stock <= 0 THEN 'Out of Stock'
                 WHEN p.stock <= p.reorder_level THEN 'Low Stock'
                 ELSE 'In Stock' END AS stock_state
     FROM products p WHERE p.active = 1
     ORDER BY p.stock <= p.reorder_level DESC, p.name`);
}

route("GET", "/api/stock", stockOverview);

route("POST", "/api/stock/adjust", (ctx) => {
  ctx.requireUser();
  const productId = parseInt(ctx.body.product_id || 0, 10);
  if (!productId) throw new AppError(400, "Select a product to adjust.");
  const qty = num(ctx.body.qty);
  if (qty === 0) throw new AppError(400, "Adjustment quantity cannot be zero.");
  logMove(ctx.db, productId, "Adjustment", qty, "MANUAL",
    text(ctx.body.note, "Manual stock adjustment") || "Manual stock adjustment");
  return { ok: true };
});

route("GET", "/api/stock/moves", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  if (ctx.query.product_id) { where.push("m.product_id = ?"); params.push(ctx.query.product_id); }
  return ctx.db.all(
    `SELECT m.*, p.name AS product_name, p.sku, p.unit
     FROM stock_moves m JOIN products p ON p.id = m.product_id
     WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT 300`, params);
});

route("DELETE", "/api/stock/moves", (ctx) => {
  ctx.requireAdmin();
  if (!wantsCascade(ctx)) {
    blocked("This clears the whole movement history.",
      { movements: ctx.db.scalar("SELECT COUNT(*) FROM stock_moves") });
  }
  ctx.db.run("DELETE FROM stock_moves");
  return { ok: true };
});

// ------------------------------------------------------ dashboard & reports

route("GET", "/api/dashboard", (ctx) => {
  ctx.requireUser();
  const db = ctx.db;
  const start = monthStart();
  return {
    sales_month: round2(db.scalar(
      "SELECT SUM(total) FROM invoices WHERE invoice_date >= ?", [start])),
    purchases_month: round2(db.scalar(
      "SELECT SUM(total) FROM purchases WHERE purchase_date >= ?", [start])),
    receivables: round2(db.scalar(
      "SELECT SUM(total - paid) FROM invoices WHERE total > paid")),
    payables: round2(db.scalar(
      "SELECT SUM(total - paid) FROM purchases WHERE total > paid")),
    stock_value: round2(db.scalar(
      "SELECT SUM(stock * purchase_price) FROM products WHERE active = 1")),
    open_orders: db.scalar(
      "SELECT COUNT(*) FROM orders WHERE status IN ('Pending','Confirmed')"),
    pending_deliveries: db.scalar(
      `SELECT COUNT(*) FROM orders WHERE status <> 'Cancelled'
       AND delivery_status NOT IN ('Delivered','Returned')`),
    low_stock_count: db.scalar(
      "SELECT COUNT(*) FROM products WHERE active = 1 AND stock <= reorder_level"),
    customers: db.scalar("SELECT COUNT(*) FROM customers WHERE active = 1"),
    suppliers: db.scalar("SELECT COUNT(*) FROM suppliers WHERE active = 1"),
    products: db.scalar("SELECT COUNT(*) FROM products WHERE active = 1"),
    sales_trend: db.all(
      `SELECT invoice_date AS d, ROUND(SUM(total), 2) AS amount FROM invoices
       WHERE invoice_date >= date('now', '-13 days')
       GROUP BY invoice_date ORDER BY invoice_date`),
    recent_orders: db.all(
      `SELECT o.id, o.order_no, o.order_date, o.status, o.delivery_status, o.total,
              c.name AS customer_name
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ORDER BY o.id DESC LIMIT 8`),
    low_stock: db.all(
      `SELECT id, sku, name, stock, reorder_level, unit FROM products
       WHERE active = 1 AND stock <= reorder_level ORDER BY stock LIMIT 8`),
  };
});

function reportSales(ctx) {
  ctx.requireUser();
  const start = text(ctx.query.from, monthStart()) || monthStart();
  const end = text(ctx.query.to, today()) || today();
  const db = ctx.db;
  return {
    from: start, to: end,
    summary: db.get(
      `SELECT COUNT(*) AS invoices, ROUND(COALESCE(SUM(total),0),2) AS total,
              ROUND(COALESCE(SUM(paid),0),2) AS paid,
              ROUND(COALESCE(SUM(total - paid),0),2) AS outstanding,
              ROUND(COALESCE(SUM(tax),0),2) AS tax,
              ROUND(COALESCE(SUM(discount),0),2) AS discount
       FROM invoices WHERE invoice_date BETWEEN ? AND ?`, [start, end]),
    by_day: db.all(
      `SELECT invoice_date AS d, COUNT(*) AS n, ROUND(SUM(total),2) AS amount FROM invoices
       WHERE invoice_date BETWEEN ? AND ? GROUP BY invoice_date ORDER BY invoice_date`,
      [start, end]),
    by_customer: db.all(
      `SELECT c.name, COUNT(*) AS n, ROUND(SUM(i.total),2) AS amount,
              ROUND(SUM(i.total - i.paid),2) AS outstanding
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.invoice_date BETWEEN ? AND ? GROUP BY c.id ORDER BY amount DESC`, [start, end]),
    by_product: db.all(
      `SELECT p.sku, p.name, p.unit, ROUND(SUM(ii.qty),2) AS qty,
              ROUND(SUM(ii.line_total),2) AS amount
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       JOIN products p ON p.id = ii.product_id
       WHERE i.invoice_date BETWEEN ? AND ? GROUP BY p.id ORDER BY amount DESC`, [start, end]),
  };
}

route("GET", "/api/reports/sales", reportSales);

function reportPurchases(ctx) {
  ctx.requireUser();
  const start = text(ctx.query.from, monthStart()) || monthStart();
  const end = text(ctx.query.to, today()) || today();
  const db = ctx.db;
  return {
    from: start, to: end,
    summary: db.get(
      `SELECT COUNT(*) AS purchases, ROUND(COALESCE(SUM(total),0),2) AS total,
              ROUND(COALESCE(SUM(paid),0),2) AS paid,
              ROUND(COALESCE(SUM(total - paid),0),2) AS outstanding
       FROM purchases WHERE purchase_date BETWEEN ? AND ?`, [start, end]),
    by_supplier: db.all(
      `SELECT s.name, COUNT(*) AS n, ROUND(SUM(p.total),2) AS amount,
              ROUND(SUM(p.total - p.paid),2) AS outstanding
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.purchase_date BETWEEN ? AND ? GROUP BY s.id ORDER BY amount DESC`, [start, end]),
    by_product: db.all(
      `SELECT pr.sku, pr.name, pr.unit, ROUND(SUM(pi.qty),2) AS qty,
              ROUND(SUM(pi.line_total),2) AS amount
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       JOIN products pr ON pr.id = pi.product_id
       WHERE p.purchase_date BETWEEN ? AND ? GROUP BY pr.id ORDER BY amount DESC`, [start, end]),
  };
}

route("GET", "/api/reports/purchases", reportPurchases);

function reportInventory(ctx) {
  ctx.requireUser();
  return {
    summary: ctx.db.get(
      `SELECT COUNT(*) AS products,
              ROUND(COALESCE(SUM(stock * purchase_price),0),2) AS cost_value,
              ROUND(COALESCE(SUM(stock * sale_price),0),2) AS retail_value,
              SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN stock > 0 AND stock <= reorder_level THEN 1 ELSE 0 END) AS low_stock
       FROM products WHERE active = 1`),
    by_category: ctx.db.all(
      `SELECT COALESCE(NULLIF(category,''),'Uncategorised') AS category, COUNT(*) AS n,
              ROUND(SUM(stock),2) AS qty, ROUND(SUM(stock * purchase_price),2) AS cost_value
       FROM products WHERE active = 1 GROUP BY category ORDER BY cost_value DESC`),
    items: stockOverview(ctx),
  };
}

route("GET", "/api/reports/inventory", reportInventory);

// --------------------------------------------------------------- bookkeeping
//
// Every financial event posts a balanced journal entry. The statements are read
// back from those entries, never recomputed from documents, so what the reports
// show is exactly what the ledger holds. post() refuses to write anything that
// does not balance - a ledger that can drift is worse than no ledger.

const NORMAL_DEBIT = ["Asset", "Expense"];   // these grow with debits

function accountId(db, code) {
  const row = db.get("SELECT id FROM accounts WHERE code = ?", [code]);
  return row ? row.id : null;
}

/** Write one balanced entry. lines: [account code or id, debit, credit, memo] */
function post(db, entryDate, memo, lines, source = "Manual", sourceId = null) {
  const prepared = [];
  for (const [account, rawDebit, rawCredit, note] of lines) {
    const acc = typeof account === "number" ? account : accountId(db, account);
    if (acc === null || acc === undefined) throw new AppError(400, `No such account: ${account}`);
    const debit = round2(rawDebit || 0);
    const credit = round2(rawCredit || 0);
    if (debit && credit) {
      throw new AppError(400, "A line is either a debit or a credit, not both.");
    }
    if (debit || credit) prepared.push([acc, debit, credit, note]);
  }
  if (!prepared.length) return null;

  const debits = round2(sum(prepared, (l) => l[1]));
  const credits = round2(sum(prepared, (l) => l[2]));
  if (Math.abs(debits - credits) > 0.005) {
    throw new AppError(400, `Entry does not balance: debits ${debits} vs credits ${credits}.`);
  }
  const number = nextNumber(db, "journal_entries", "entry_no", "JV");
  const { id: entryId } = db.run(
    `INSERT INTO journal_entries (entry_no, entry_date, memo, source, source_id)
     VALUES (?,?,?,?,?)`, [number, entryDate, memo, source, sourceId]);
  for (const [acc, debit, credit, note] of prepared) {
    db.run(`INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo)
            VALUES (?,?,?,?,?)`, [entryId, acc, debit, credit, note || ""]);
  }
  return entryId;
}

/** Remove the entries a document produced, used when it is deleted. */
function unpost(db, source, sourceId) {
  for (const row of db.all(
    "SELECT id FROM journal_entries WHERE source = ? AND source_id = ?", [source, sourceId])) {
    db.run("DELETE FROM journal_lines WHERE entry_id = ?", [row.id]);
    db.run("DELETE FROM journal_entries WHERE id = ?", [row.id]);
  }
}

/** Sale on credit: the customer owes us, income is earned, tax is collected. */
function postInvoice(db, invoiceId) {
  const inv = db.get("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!inv) return;
  unpost(db, "Invoice", invoiceId);
  const memo = `Invoice ${inv.invoice_no}`;
  const lines = [["1100", inv.total, 0, memo], ["4000", 0, inv.subtotal, memo]];
  if (inv.discount) lines.push(["4100", inv.discount, 0, "Discount given"]);
  if (inv.tax) lines.push(["2100", 0, inv.tax, "Tax on sale"]);
  post(db, inv.invoice_date, memo, lines, "Invoice", invoiceId);
}

/** Goods leaving the shelf become a cost, at what they cost us to buy. */
function postCogs(db, orderId) {
  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return;
  unpost(db, "COGS", orderId);
  const cost = round2(db.scalar(
    `SELECT COALESCE(SUM(oi.qty * p.purchase_price), 0)
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`, [orderId]));
  if (cost <= 0) return;
  const memo = `Cost of goods on ${order.order_no}`;
  post(db, order.order_date, memo,
    [["5000", cost, 0, memo], ["1200", 0, cost, memo]], "COGS", orderId);
}

/** Goods bought on credit: stock rises, we owe the supplier. */
function postPurchase(db, purchaseId) {
  const pur = db.get("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
  if (!pur) return;
  unpost(db, "Purchase", purchaseId);
  const memo = `Purchase ${pur.purchase_no}`;
  const goods = round2(pur.subtotal - pur.discount);
  const lines = [["1200", goods, 0, memo], ["2000", 0, pur.total, memo]];
  if (pur.tax) lines.push(["2100", pur.tax, 0, "Tax on purchase"]);
  post(db, pur.purchase_date, memo, lines, "Purchase", purchaseId);
}

function postReceipt(db, invoiceId, amount, accountCode, when) {
  const inv = db.get("SELECT invoice_no FROM invoices WHERE id = ?", [invoiceId]);
  const memo = inv ? `Payment received on ${inv.invoice_no}` : "Payment received";
  post(db, when, memo,
    [[accountCode, amount, 0, memo], ["1100", 0, amount, memo]], "Receipt", invoiceId);
}

function postSupplierPayment(db, purchaseId, amount, accountCode, when) {
  const pur = db.get("SELECT purchase_no FROM purchases WHERE id = ?", [purchaseId]);
  const memo = pur ? `Paid supplier for ${pur.purchase_no}` : "Supplier payment";
  post(db, when, memo,
    [["2000", amount, 0, memo], [accountCode, 0, amount, memo]], "Payment", purchaseId);
}

// ------------------------------------------------------------------ deletion
//
// Anything can be removed, but never silently: a delete that would take other
// records with it is refused until the caller passes cascade=1, and the refusal
// says exactly what would go. Stock is unwound first so inventory stays true.

function purgeOrder(db, orderId) {
  const order = db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return;
  if (order.stock_applied) applyOrderStock(db, orderId, +1);
  for (const invoice of db.all("SELECT id FROM invoices WHERE order_id = ?", [orderId])) {
    unpost(db, "Invoice", invoice.id);
    unpost(db, "Receipt", invoice.id);
    db.run("DELETE FROM invoice_items WHERE invoice_id = ?", [invoice.id]);
    db.run("DELETE FROM invoices WHERE id = ?", [invoice.id]);
  }
  unpost(db, "COGS", orderId);
  db.run("DELETE FROM order_items WHERE order_id = ?", [orderId]);
  db.run("DELETE FROM orders WHERE id = ?", [orderId]);
}

function purgeInvoice(db, invoiceId) {
  const invoice = db.get("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice) return;
  if (invoice.order_id === null) {
    // a direct sale moved stock on its own, so give it back
    for (const item of db.all("SELECT * FROM invoice_items WHERE invoice_id = ?", [invoiceId])) {
      logMove(db, item.product_id, "Sale Return", item.qty, invoice.invoice_no, "Invoice deleted");
    }
  }
  for (const kind of ["Invoice", "Receipt", "COGS-Invoice"]) unpost(db, kind, invoiceId);
  db.run("DELETE FROM invoice_items WHERE invoice_id = ?", [invoiceId]);
  db.run("DELETE FROM invoices WHERE id = ?", [invoiceId]);
}

function purgePurchase(db, purchaseId) {
  const purchase = db.get("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
  if (!purchase) return;
  if (purchase.stock_applied) applyPurchaseStock(db, purchaseId, -1);
  unpost(db, "Purchase", purchaseId);
  unpost(db, "Payment", purchaseId);
  db.run("DELETE FROM purchase_items WHERE purchase_id = ?", [purchaseId]);
  db.run("DELETE FROM purchases WHERE id = ?", [purchaseId]);
}

// ------------------------------------------------------- accounts & journal

route("GET", "/api/accounts", (ctx) => {
  ctx.requireUser();
  return ctx.db.all(
    `SELECT a.*,
            ROUND(COALESCE((SELECT SUM(l.debit) FROM journal_lines l
                            WHERE l.account_id = a.id), 0), 2) AS debits,
            ROUND(COALESCE((SELECT SUM(l.credit) FROM journal_lines l
                            WHERE l.account_id = a.id), 0), 2) AS credits
     FROM accounts a ORDER BY a.code`);
});

route("POST", "/api/accounts", (ctx) => {
  ctx.requireUser();
  const code = text(ctx.body.code);
  const name = text(ctx.body.name);
  const kind = text(ctx.body.type);
  if (!code || !name) throw new AppError(400, "Account code and name are required.");
  if (!["Asset", "Liability", "Equity", "Income", "Expense"].includes(kind)) {
    throw new AppError(400, "Type must be Asset, Liability, Equity, Income or Expense.");
  }
  if (ctx.db.get("SELECT 1 FROM accounts WHERE code = ?", [code])) {
    throw new AppError(400, `Account ${code} already exists.`);
  }
  const { id } = ctx.db.run(
    "INSERT INTO accounts (code, name, type, subtype, is_cash) VALUES (?,?,?,?,?)",
    [code, name, kind, text(ctx.body.subtype), ctx.body.is_cash ? 1 : 0]);
  return { id };
});

route("DELETE", "/api/accounts/(\\d+)", (ctx, accountKey) => {
  ctx.requireUser();
  const account = ctx.db.get("SELECT * FROM accounts WHERE id = ?", [accountKey]);
  if (!account) throw new AppError(404, "Account not found.");
  if (account.system) {
    throw new AppError(400, "This account is used by the system and cannot be removed.");
  }
  const used = ctx.db.scalar("SELECT COUNT(*) FROM journal_lines WHERE account_id = ?",
    [accountKey]);
  if (used && !wantsCascade(ctx)) {
    blocked("This account has postings against it.", { journal_lines: used });
  }
  ctx.db.run("DELETE FROM accounts WHERE id = ?", [accountKey]);
  return { ok: true };
});

route("GET", "/api/journal", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  if (ctx.query.from) { where.push("e.entry_date >= ?"); params.push(ctx.query.from); }
  if (ctx.query.to) { where.push("e.entry_date <= ?"); params.push(ctx.query.to); }
  if (ctx.query.account_id) {
    where.push("EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_id = ?)");
    params.push(ctx.query.account_id);
  }
  const entries = ctx.db.all(
    `SELECT e.* FROM journal_entries e WHERE ${where.join(" AND ")}
     ORDER BY e.entry_date DESC, e.id DESC LIMIT 300`, params);
  for (const entry of entries) {
    entry.lines = ctx.db.all(
      `SELECT l.*, a.code, a.name FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?
       ORDER BY l.debit DESC`, [entry.id]);
  }
  return entries;
});

route("POST", "/api/journal", (ctx) => {
  ctx.requireUser();
  const lines = [];
  for (const raw of ctx.body.lines || []) {
    if (!raw.account_id) continue;
    lines.push([parseInt(raw.account_id, 10), num(raw.debit), num(raw.credit), text(raw.memo)]);
  }
  if (lines.length < 2) throw new AppError(400, "An entry needs at least two lines.");
  const id = post(ctx.db, text(ctx.body.entry_date, today()) || today(),
    text(ctx.body.memo), lines, "Manual");
  return { id };
});

route("DELETE", "/api/journal/(\\d+)", (ctx, entryId) => {
  ctx.requireUser();
  const entry = ctx.db.get("SELECT source FROM journal_entries WHERE id = ?", [entryId]);
  if (!entry) throw new AppError(404, "Entry not found.");
  if (entry.source !== "Manual") {
    throw new AppError(400, "This entry belongs to a document. Delete the document instead.");
  }
  ctx.db.run("DELETE FROM journal_lines WHERE entry_id = ?", [entryId]);
  ctx.db.run("DELETE FROM journal_entries WHERE id = ?", [entryId]);
  return { ok: true };
});

route("POST", "/api/expenses", (ctx) => {
  // Money out that is not a supplier bill - rent, wages, fuel.
  ctx.requireUser();
  const amount = num(ctx.body.amount);
  if (amount <= 0) throw new AppError(400, "Enter an amount greater than zero.");
  const expense = text(ctx.body.expense_account, "6900") || "6900";
  const paidFrom = text(ctx.body.paid_from, "1000") || "1000";
  const memo = text(ctx.body.memo, "Expense") || "Expense";
  const id = post(ctx.db, text(ctx.body.entry_date, today()) || today(), memo,
    [[expense, amount, 0, memo], [paidFrom, 0, amount, memo]], "Expense");
  return { id };
});

function balances(db, start = null, end = null) {
  const where = ["1=1"];
  const params = [];
  if (start) { where.push("e.entry_date >= ?"); params.push(start); }
  if (end) { where.push("e.entry_date <= ?"); params.push(end); }
  return db.all(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.is_cash,
            ROUND(COALESCE(SUM(l.debit), 0), 2)  AS debit,
            ROUND(COALESCE(SUM(l.credit), 0), 2) AS credit
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_id = a.id
     LEFT JOIN journal_entries e ON e.id = l.entry_id AND ${where.join(" AND ")}
     GROUP BY a.id ORDER BY a.code`, params);
}

/** Balance in the direction the account naturally runs. */
function signed(account) {
  const diff = account.debit - account.credit;
  return round2(NORMAL_DEBIT.includes(account.type) ? diff : -diff);
}

route("GET", "/api/reports/trial-balance", (ctx) => {
  ctx.requireUser();
  const end = text(ctx.query.to, today()) || today();
  const accounts = balances(ctx.db, null, end).filter((a) => a.debit || a.credit);
  for (const a of accounts) {
    const net = round2(a.debit - a.credit);
    a.debit_balance = net > 0 ? net : 0;
    a.credit_balance = net < 0 ? -net : 0;
  }
  return { to: end, accounts,
    total_debit: round2(sum(accounts, (a) => a.debit_balance)),
    total_credit: round2(sum(accounts, (a) => a.credit_balance)) };
});

route("GET", "/api/reports/profit-loss", (ctx) => {
  ctx.requireUser();
  const start = text(ctx.query.from, monthStart()) || monthStart();
  const end = text(ctx.query.to, today()) || today();
  const accounts = balances(ctx.db, start, end);
  const pick = (kind) => accounts
    .filter((a) => a.type === kind && (a.debit || a.credit))
    .map((a) => ({ ...a, amount: signed(a) }));
  const income = pick("Income");
  const expense = pick("Expense");
  const totalIncome = round2(sum(income, (a) => a.amount));
  const costOfSales = round2(sum(
    expense.filter((a) => a.subtype === "Cost of Sales"), (a) => a.amount));
  const operating = round2(sum(
    expense.filter((a) => a.subtype !== "Cost of Sales"), (a) => a.amount));
  return { from: start, to: end, income, expense,
    total_income: totalIncome, cost_of_sales: costOfSales,
    gross_profit: round2(totalIncome - costOfSales),
    operating_expenses: operating,
    net_profit: round2(totalIncome - costOfSales - operating) };
});

route("GET", "/api/reports/balance-sheet", (ctx) => {
  ctx.requireUser();
  const end = text(ctx.query.to, today()) || today();
  const accounts = balances(ctx.db, null, end);
  const pick = (kind) => accounts
    .filter((a) => a.type === kind && (a.debit || a.credit))
    .map((a) => ({ ...a, amount: signed(a) }));
  const assets = pick("Asset");
  const liabilities = pick("Liability");
  const equity = pick("Equity");
  // Profit for the period has not been closed to equity, so show it there.
  const earned = round2(
    sum(accounts.filter((a) => a.type === "Income"), signed)
    - sum(accounts.filter((a) => a.type === "Expense"), signed));
  const totalAssets = round2(sum(assets, (a) => a.amount));
  const totalLiabilities = round2(sum(liabilities, (a) => a.amount));
  const totalEquity = round2(sum(equity, (a) => a.amount) + earned);
  return { to: end, assets, liabilities, equity, retained_this_period: earned,
    total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
    balances: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.05 };
});

route("GET", "/api/reports/ledger/(\\d+)", (ctx, accountKey) => {
  ctx.requireUser();
  const account = ctx.db.get("SELECT * FROM accounts WHERE id = ?", [accountKey]);
  if (!account) throw new AppError(404, "Account not found.");
  const lines = ctx.db.all(
    `SELECT e.entry_no, e.entry_date, e.memo, e.source, l.debit, l.credit,
            l.memo AS line_memo
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? ORDER BY e.entry_date, e.id`, [accountKey]);
  let running = 0;
  for (const line of lines) {
    const delta = line.debit - line.credit;
    running = round2(running + (NORMAL_DEBIT.includes(account.type) ? delta : -delta));
    line.balance = running;
  }
  return { account, lines, closing: running };
});

route("GET", "/api/reports/aging", (ctx) => {
  // Who owes us, and whom we owe, sorted by how overdue it is.
  ctx.requireUser();
  const payable = ctx.query.kind === "payable";
  const asAt = text(ctx.query.to, today()) || today();
  const sql = payable
    ? `SELECT p.purchase_no AS ref, p.purchase_date AS doc_date, s.name AS party,
              ROUND(p.total - p.paid, 2) AS outstanding
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.total - p.paid > 0.005 AND p.purchase_date <= ?`
    : `SELECT i.invoice_no AS ref, i.invoice_date AS doc_date, c.name AS party,
              ROUND(i.total - i.paid, 2) AS outstanding
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.total - i.paid > 0.005 AND i.invoice_date <= ?`;
  const docs = ctx.db.all(`${sql} ORDER BY doc_date`, [asAt]);

  const cutoff = Date.parse(`${asAt}T00:00:00Z`);
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
  const parties = new Map();
  for (const doc of docs) {
    const stamp = Date.parse(`${doc.doc_date}T00:00:00Z`);
    const age = Number.isNaN(stamp) ? 0 : Math.round((cutoff - stamp) / 86400000);
    const band = age <= 0 ? "current" : age <= 30 ? "d30"
      : age <= 60 ? "d60" : age <= 90 ? "d90" : "older";
    doc.days = age;
    doc.band = band;
    buckets[band] = round2(buckets[band] + doc.outstanding);
    if (!parties.has(doc.party)) {
      parties.set(doc.party, { party: doc.party, total: 0,
        current: 0, d30: 0, d60: 0, d90: 0, older: 0 });
    }
    const row = parties.get(doc.party);
    row[band] = round2(row[band] + doc.outstanding);
    row.total = round2(row.total + doc.outstanding);
  }
  return { kind: payable ? "payable" : "receivable", to: asAt, documents: docs,
    by_party: [...parties.values()].sort((a, b) => b.total - a.total),
    buckets, total: round2(sum(Object.values(buckets))) };
});

route("GET", "/api/reports/reconcile/(\\d+)", (ctx, accountKey) => {
  // Tick postings off against a bank statement.
  ctx.requireUser();
  const account = ctx.db.get("SELECT * FROM accounts WHERE id = ?", [accountKey]);
  if (!account) throw new AppError(404, "Account not found.");
  const asAt = text(ctx.query.to, today()) || today();
  const lines = ctx.db.all(
    `SELECT l.id, l.debit, l.credit, l.cleared, l.cleared_date, l.memo,
            e.entry_no, e.entry_date, e.memo AS entry_memo, e.source
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND e.entry_date <= ?
     ORDER BY e.entry_date, e.id`, [accountKey, asAt]);
  const ledger = round2(sum(lines, (l) => l.debit - l.credit));
  const cleared = round2(sum(lines.filter((l) => l.cleared), (l) => l.debit - l.credit));
  return { account, to: asAt, lines, ledger_balance: ledger,
    cleared_balance: cleared, uncleared: round2(ledger - cleared) };
});

route("POST", "/api/journal/lines/(\\d+)/clear", (ctx, lineId) => {
  ctx.requireUser();
  const cleared = ctx.body.cleared === undefined || ctx.body.cleared ? 1 : 0;
  ctx.db.run("UPDATE journal_lines SET cleared = ?, cleared_date = ? WHERE id = ?",
    [cleared, cleared ? today() : "", lineId]);
  return { ok: true, cleared: Boolean(cleared) };
});

route("GET", "/api/accounting/closings", (ctx) => {
  ctx.requireUser();
  return ctx.db.all(
    `SELECT c.*, e.entry_no FROM closings c
     LEFT JOIN journal_entries e ON e.id = c.entry_id ORDER BY c.closed_to DESC`);
});

route("POST", "/api/accounting/close", (ctx) => {
  // Sweep income and expense into retained earnings, so the new year starts
  // from zero and the balance sheet carries the profit.
  ctx.requireAdmin();
  const toDate = text(ctx.body.to, today()) || today();
  if (text(ctx.body.confirm) !== "CLOSE") throw new AppError(400, "Type CLOSE to confirm.");
  const last = ctx.db.get("SELECT closed_to FROM closings ORDER BY closed_to DESC LIMIT 1");
  const start = last ? last.closed_to : null;
  if (start && toDate <= start) {
    throw new AppError(400, `The books are already closed to ${start}.`);
  }
  const accounts = balances(ctx.db, start, toDate);
  const lines = [];
  let profit = 0;
  for (const a of accounts) {
    const net = round2(a.debit - a.credit);
    if (!["Income", "Expense"].includes(a.type) || !net) continue;
    // close the account by posting the opposite of its balance
    lines.push([a.id, net < 0 ? -net : 0, net > 0 ? net : 0, "Year-end close"]);
    profit = round2(profit - net);   // income is credit-negative, expense positive
  }
  if (!lines.length) throw new AppError(400, "There is nothing to close for this period.");
  lines.push([accountId(ctx.db, "3900"), profit >= 0 ? 0 : -profit, profit >= 0 ? profit : 0,
    "Profit carried to retained earnings"]);
  const entryId = post(ctx.db, toDate, `Year-end close to ${toDate}`, lines, "Closing");
  ctx.db.run("INSERT INTO closings (closed_to, entry_id, net_profit) VALUES (?,?,?)",
    [toDate, entryId, profit]);
  return { ok: true, closed_to: toDate, net_profit: profit, entry_id: entryId };
});

route("GET", "/api/assets", (ctx) => {
  ctx.requireUser();
  return ctx.db.all("SELECT * FROM fixed_assets ORDER BY purchase_date DESC");
});

route("POST", "/api/assets", (ctx) => {
  ctx.requireUser();
  const name = text(ctx.body.name);
  const cost = num(ctx.body.cost);
  const life = parseInt(num(ctx.body.life_months, 60), 10) || 60;
  if (!name || cost <= 0) throw new AppError(400, "Give the asset a name and a cost above zero.");
  const { id } = ctx.db.run(
    `INSERT INTO fixed_assets (name, purchase_date, cost, salvage, life_months)
     VALUES (?,?,?,?,?)`,
    [name, text(ctx.body.purchase_date, today()) || today(), cost, num(ctx.body.salvage), life]);
  return { id };
});

route("DELETE", "/api/assets/(\\d+)", (ctx, assetId) => {
  ctx.requireUser();
  ctx.db.run("DELETE FROM fixed_assets WHERE id = ?", [assetId]);
  return { ok: true };
});

route("POST", "/api/assets/depreciate", (ctx) => {
  // One month of straight-line depreciation for every asset still due.
  ctx.requireUser();
  const upto = text(ctx.body.to, today()) || today();
  const posted = [];
  let total = 0;
  for (const asset of ctx.db.all("SELECT * FROM fixed_assets WHERE active = 1")) {
    const monthly = round2((asset.cost - asset.salvage) / Math.max(asset.life_months, 1));
    if (monthly <= 0) continue;
    const already = ctx.db.scalar(
      `SELECT COALESCE(SUM(l.debit), 0) FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source = 'Depreciation' AND e.source_id = ?`, [asset.id]);
    const remaining = round2(asset.cost - asset.salvage - already);
    if (remaining <= 0) continue;
    const amount = Math.min(monthly, remaining);
    const memo = `Depreciation - ${asset.name}`;
    post(ctx.db, upto, memo,
      [[asset.expense_account, amount, 0, memo], ["1590", 0, amount, memo]],
      "Depreciation", asset.id);
    ctx.db.run("UPDATE fixed_assets SET depreciated_to = ? WHERE id = ?", [upto, asset.id]);
    posted.push({ asset: asset.name, amount });
    total = round2(total + amount);
  }
  return { posted, total };
});

// ---------------------------------------------------- bookings taken in field

route("GET", "/api/field/entries", (ctx) => {
  ctx.requireUser();
  const where = ["1=1"];
  const params = [];
  if (ctx.query.status) { where.push("status = ?"); params.push(ctx.query.status); }
  return ctx.db.all(
    `SELECT * FROM field_entries WHERE ${where.join(" AND ")}
     ORDER BY id DESC LIMIT 300`, params).map((e) => ({
    ...e, items: JSON.parse(e.items || "[]"),
  }));
});

route("POST", "/api/field/entries/(\\d+)/convert", (ctx, entryId) => {
  // Turn a reviewed field entry into a real order or purchase.
  ctx.requireUser();
  const entry = ctx.db.get("SELECT * FROM field_entries WHERE id = ?", [entryId]);
  if (!entry) throw new AppError(404, "Entry not found.");
  if (entry.status !== "Pending") {
    throw new AppError(400, `This entry is already ${entry.status.toLowerCase()}.`);
  }

  const items = [];
  for (const line of JSON.parse(entry.items || "[]")) {
    const product = ctx.db.get("SELECT id FROM products WHERE sku = ?", [text(line.sku)]);
    if (!product) {
      throw new AppError(400,
        `No product matches code '${line.sku}'. Add it first, then convert.`);
    }
    const qty = num(line.qty);
    const price = num(line.price);
    items.push({ product_id: product.id, qty, price, line_total: round2(qty * price) });
  }
  if (!items.length) throw new AppError(400, "This entry has no items to convert.");

  const partyTable = entry.kind === "Purchase" ? "suppliers" : "customers";
  let party = ctx.db.get(`SELECT id FROM ${partyTable} WHERE name = ?`, [entry.party_name]);
  if (!party) {
    party = { id: ctx.db.run(
      `INSERT INTO ${partyTable} (name, phone, city) VALUES (?,?,?)`,
      [entry.party_name || "Unnamed", entry.phone, entry.city]).id };
  }

  const subtotal = round2(sum(items, (i) => i.line_total));
  const note = `From field entry ${(entry.client_id || "").slice(0, 8)}. ${entry.notes}`.trim();

  let number;
  let newId;
  let target;
  if (entry.kind === "Purchase") {
    number = nextNumber(ctx.db, "purchases", "purchase_no", "PUR");
    newId = ctx.db.run(
      `INSERT INTO purchases (purchase_no, supplier_id, purchase_date, subtotal,
                              total, status, notes)
       VALUES (?,?,?,?,?, 'Ordered', ?)`,
      [number, party.id, entry.entry_date, subtotal, subtotal, note]).id;
    for (const item of items) {
      ctx.db.run(
        `INSERT INTO purchase_items (purchase_id, product_id, qty, price, line_total)
         VALUES (?,?,?,?,?)`, [newId, item.product_id, item.qty, item.price, item.line_total]);
    }
    target = "purchases";
  } else {
    number = nextNumber(ctx.db, "orders", "order_no", "ORD");
    newId = ctx.db.run(
      `INSERT INTO orders (order_no, customer_id, order_date, status,
                           delivery_status, notes, subtotal, total)
       VALUES (?,?,?, 'Pending', 'Not Dispatched', ?,?,?)`,
      [number, party.id, entry.entry_date, note, subtotal, subtotal]).id;
    for (const item of items) {
      ctx.db.run(
        `INSERT INTO order_items (order_id, product_id, qty, price, line_total)
         VALUES (?,?,?,?,?)`, [newId, item.product_id, item.qty, item.price, item.line_total]);
    }
    target = "orders";
  }

  ctx.db.run(
    "UPDATE field_entries SET status = 'Converted', linked_id = ?, linked_no = ? WHERE id = ?",
    [newId, number, entryId]);
  return { ok: true, target, id: newId, number };
});

route("POST", "/api/field/entries/(\\d+)/reject", (ctx, entryId) => {
  ctx.requireUser();
  ctx.db.run("UPDATE field_entries SET status = 'Rejected' WHERE id = ?", [entryId]);
  return { ok: true };
});

route("DELETE", "/api/field/entries/(\\d+)", (ctx, entryId) => {
  ctx.requireUser();
  if (!ctx.db.get("SELECT 1 FROM field_entries WHERE id = ?", [entryId])) {
    throw new AppError(404, "Entry not found.");
  }
  ctx.db.run("DELETE FROM field_entries WHERE id = ?", [entryId]);
  return { ok: true };
});

// -------------------------------------------------------------------- danger

const TRANSACTION_TABLES = ["invoice_items", "invoices", "order_items", "orders",
  "purchase_items", "purchases", "stock_moves", "field_entries",
  "journal_lines", "journal_entries", "closings", "fixed_assets"];

route("POST", "/api/danger/clear", (ctx) => {
  // scope=transactions keeps the catalogue and contacts;
  // scope=everything also removes items, customers and suppliers.
  ctx.requireAdmin();
  const scope = text(ctx.body.scope);
  if (!["transactions", "everything"].includes(scope)) {
    throw new AppError(400, "scope must be 'transactions' or 'everything'.");
  }
  if (text(ctx.body.confirm) !== "DELETE") throw new AppError(400, "Type DELETE to confirm.");

  const tables = [...TRANSACTION_TABLES];
  if (scope === "everything") tables.push("products", "customers", "suppliers");
  const removed = {};
  for (const table of tables) {
    removed[table] = ctx.db.scalar(`SELECT COUNT(*) FROM ${table}`);
    ctx.db.run(`DELETE FROM ${table}`);
  }
  if (scope === "transactions") ctx.db.run("UPDATE products SET stock = 0");
  // put the item master back so the program stays usable
  if (scope === "everything") ctx.reseed();
  return { ok: true, scope, removed };
});

// ------------------------------------------------------------------ dispatch

/**
 * Run one operation.
 * @param {object} ctx  carries db, user and the access helpers
 * @param {string} method  GET / POST / PUT / DELETE
 * @param {string} path    e.g. /api/invoices/3
 * @param {object} body    the posted object
 * @param {object} query   the query-string values
 */
export function dispatch(ctx, method, path, body = {}, query = {}) {
  const scoped = { ...ctx, body: body || {}, query: query || {} };
  for (const { method: verb, pattern, fn } of ROUTES) {
    if (verb !== method) continue;
    const match = pattern.exec(path);
    if (!match) continue;
    return fn(scoped, ...match.slice(1));
  }
  throw new AppError(404, `No operation for ${method} ${path}`);
}

export const routeCount = () => ROUTES.length;
export { post, balances, today, num, text };
