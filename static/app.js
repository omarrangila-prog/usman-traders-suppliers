/* Usman Traders & Suppliers - Business Management System (front end) */
(function () {
"use strict";

// ---------------------------------------------------------------- utilities

const $ = (sel, root) => (root || document).querySelector(sel);
const el = (id) => document.getElementById(id);

function h(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const state = { user: null, company: {}, products: [], customers: [], suppliers: [], nav: {} };

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function cur(value) { return (state.company.currency || "PKR") + " " + money(value); }
function qty(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}
function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(String(value).slice(0, 10) + "T00:00:00");
  if (isNaN(d)) return h(value);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() { return today().slice(0, 8) + "01"; }

async function api(path, options) {
  const opts = Object.assign({ headers: { "Content-Type": "application/json" } }, options || {});
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  let res;
  try {
    res = await fetch("/api" + path, opts);
  } catch (networkError) {
    // fetch only rejects when the request never reached a server
    const offline = new Error("No connection to the office.");
    offline.offline = true;
    throw offline;
  }
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (res.status === 401 && state.user) { showLogin(); throw new Error("Session expired. Please sign in again."); }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    if (res.status === 409 && (data.error || "").includes("|IMPACT|")) {
      const [message, detail] = data.error.split("|IMPACT|");
      err.message = message.trim();
      try { err.impact = JSON.parse(detail); } catch (_) { /* no detail */ }
    }
    throw err;
  }
  return data;
}

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  el("toast-root").appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

// ------------------------------------------------------------------ modals

function closeModal() { el("modal-root").innerHTML = ""; }

/** Open a modal. `render` returns HTML; `onSubmit(form)` runs on save. */
function modal({ title, body, submitLabel, onSubmit, wide, footer }) {
  el("modal-root").innerHTML = `
    <div class="modal-backdrop">
      <form class="modal ${wide ? "wide" : ""}">
        <div class="modal-head"><h2>${h(title)}</h2>
          <button type="button" class="icon-btn" data-close>&times;</button></div>
        <div class="modal-body">
          <div class="form-error hidden" data-error></div>
          ${body}
        </div>
        <div class="modal-foot">
          ${footer || ""}
          <button type="button" class="btn" data-close>Cancel</button>
          ${onSubmit ? `<button type="submit" class="btn btn-primary">${h(submitLabel || "Save")}</button>` : ""}
        </div>
      </form>
    </div>`;

  const root = el("modal-root");
  const form = $("form", root);
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  $(".modal-backdrop", root).addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const button = $('button[type="submit"]', form);
    const errorBox = $("[data-error]", form);
    button.disabled = true;
    try {
      await onSubmit(form);
      closeModal();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
      button.disabled = false;
    }
  });
  const first = $("input:not([type=hidden]), select, textarea", form);
  if (first) first.focus();
  return form;
}

/**
 * Delete that explains itself. If the server refuses because other records
 * depend on this one, show exactly what would go and offer to proceed.
 */
async function deleteWithCascade(path, label, onDone) {
  try {
    await api(path, { method: "DELETE" });
    toast(label + " deleted.", "success");
    onDone();
  } catch (err) {
    if (!err.impact) { toast(err.message, "error"); return; }
    const lines = Object.entries(err.impact)
      .filter(([, v]) => v)
      .map(([k, v]) => `<li><strong>${h(v)}</strong> ${h(k.replace(/_/g, " "))}</li>`)
      .join("");
    modal({
      title: "Delete " + label + "?",
      body: `<p style="margin-top:0">${h(err.message)} Deleting it will also remove:</p>
        <ul style="margin:10px 0 0;padding-left:20px;line-height:1.8">${lines}</ul>
        <p class="muted" style="margin:14px 0 0;font-size:12.5px">
          Any stock those documents moved is put back. This cannot be undone.</p>`,
      submitLabel: "Delete everything listed",
      onSubmit: async () => {
        await api(path + (path.includes("?") ? "&" : "?") + "cascade=1", { method: "DELETE" });
        toast(label + " and related records deleted.", "success");
        onDone();
      },
    });
  }
}

function confirmDialog(message, onYes, danger) {
  modal({
    title: "Please confirm",
    body: `<p style="margin:0;line-height:1.6">${h(message)}</p>`,
    submitLabel: danger || "Yes, continue",
    onSubmit: onYes,
  });
}

function formValues(form) {
  const out = {};
  new FormData(form).forEach((v, k) => { out[k] = typeof v === "string" ? v.trim() : v; });
  form.querySelectorAll('input[type="checkbox"]').forEach((c) => { out[c.name] = c.checked; });
  return out;
}

// ------------------------------------------------------------------ badges

function statusBadge(status) {
  const map = {
    Pending: "amber", Confirmed: "blue", Delivered: "green", Cancelled: "grey",
    Paid: "green", Partial: "amber", Unpaid: "red", Received: "green", Ordered: "amber",
    "Not Dispatched": "grey", Packed: "blue", Dispatched: "blue", "In Transit": "amber",
    Returned: "red", "In Stock": "green", "Low Stock": "amber", "Out of Stock": "red",
  };
  return `<span class="badge ${map[status] || "grey"}">${h(status)}</span>`;
}

function emptyState(icon, title, hint, action) {
  return `<div class="empty"><div class="big">${icon}</div>
    <p><strong>${h(title)}</strong><br><span class="muted">${h(hint || "")}</span></p>
    ${action || ""}</div>`;
}

/**
 * Copy each column's header onto its cells as data-label. On phones the CSS
 * restacks every table into one card per record and shows those labels, so
 * views never have to describe their columns twice.
 */
function labelTableCells(root) {
  (root || document).querySelectorAll("table.data").forEach((table) => {
    const headers = Array.from(table.querySelectorAll("thead th"))
      .map((th) => th.textContent.trim());
    table.querySelectorAll("tbody tr").forEach((tr) => {
      Array.from(tr.children).forEach((cell, index) => {
        if (cell.colSpan > 1) return;          // full-width empty states
        cell.setAttribute("data-label", headers[index] || "");
        if (index === 0) cell.setAttribute("data-first", "");
      });
    });
  });
}

function tableCard(headers, bodyRows, emptyHtml) {
  // null/undefined means "show the empty state"; "" is a table filled in later.
  if (bodyRows === null || bodyRows === undefined) return `<div class="card">${emptyHtml}</div>`;
  return `<div class="card"><div class="card-body flush"><div class="table-wrap">
    <table class="data"><thead><tr>${headers}</tr></thead><tbody>${bodyRows}</tbody></table>
  </div></div></div>`;
}

// ------------------------------------------------------------ master data

async function loadMasters(force) {
  if (force || !state.products.length) {
    const [products, customers, suppliers] = await Promise.all([
      api("/products"), api("/customers"), api("/suppliers"),
    ]);
    state.products = products;
    state.customers = customers;
    state.suppliers = suppliers;
  }
}

function options(list, selected, labelFn) {
  return list.map((item) => {
    const label = labelFn ? labelFn(item) : item.name;
    return `<option value="${item.id}" ${String(item.id) === String(selected) ? "selected" : ""}>${h(label)}</option>`;
  }).join("");
}

// ------------------------------------------------------- line item editor

/**
 * Editable document lines shared by orders, invoices and purchases.
 * priceField picks which product price pre-fills a new row.
 */
function ItemEditor(host, config) {
  const priceField = config.priceField || "sale_price";
  const showStock = config.showStock !== false;
  let items = (config.items || []).map((i) => Object.assign({}, i));
  let discount = Number(config.discount || 0);
  let tax = Number(config.tax || 0);

  function productById(id) { return state.products.find((p) => String(p.id) === String(id)); }

  function addRow() { items.push({ product_id: "", qty: 1, price: 0 }); render(); }

  function render() {
    if (!items.length) items = [{ product_id: "", qty: 1, price: 0 }];
    const subtotal = items.reduce((sum, i) => sum + Number(i.qty || 0) * Number(i.price || 0), 0);
    const total = subtotal - discount + tax;

    host.innerHTML = `
      <table class="items-table">
        <thead><tr>
          <th style="width:45%">Item</th><th style="width:15%">Quantity</th>
          <th style="width:18%">Rate</th><th style="width:16%" class="num">Amount</th><th></th>
        </tr></thead>
        <tbody>
          ${items.map((item, index) => {
            const product = productById(item.product_id);
            const lineTotal = Number(item.qty || 0) * Number(item.price || 0);
            let hint = "";
            if (product && showStock) {
              const short = config.checkStock && Number(item.qty) > Number(product.stock);
              hint = `<div class="stock-hint ${short ? "warn" : ""}">In stock: ${qty(product.stock)} ${h(product.unit)}${short ? " - not enough on hand" : ""}</div>`;
            }
            return `<tr>
              <td><select data-index="${index}" data-field="product_id">
                    <option value="">Select an item...</option>
                    ${options(state.products, item.product_id, (p) => `${p.sku} - ${p.name}`)}
                  </select>${hint}</td>
              <td><input class="qty" type="number" step="0.01" min="0" data-index="${index}" data-field="qty" value="${h(item.qty)}"></td>
              <td><input class="price" type="number" step="0.01" min="0" data-index="${index}" data-field="price" value="${h(item.price)}"></td>
              <td class="line-total">${money(lineTotal)}</td>
              <td><button type="button" class="icon-btn" data-remove="${index}" title="Remove line">&times;</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      <button type="button" class="btn btn-sm" data-add>+ Add line</button>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
        <div><span>Discount</span><input type="number" step="0.01" min="0" data-total="discount" value="${discount}"></div>
        <div><span>Tax</span><input type="number" step="0.01" min="0" data-total="tax" value="${tax}"></div>
        <div class="grand"><span>Total</span><span>${cur(total)}</span></div>
      </div>`;

    host.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const { index, field } = e.target.dataset;
        items[index][field] = field === "product_id" ? e.target.value : Number(e.target.value || 0);
        if (field === "product_id") {
          const product = productById(e.target.value);
          if (product) items[index].price = Number(product[priceField] || 0);
        }
        render();
      });
    });
    host.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", (e) => {
        items.splice(Number(e.currentTarget.dataset.remove), 1);
        render();
      });
    });
    host.querySelectorAll("[data-total]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const value = Number(e.target.value || 0);
        if (e.target.dataset.total === "discount") discount = value; else tax = value;
        render();
      });
    });
    $("[data-add]", host).addEventListener("click", addRow);
  }

  render();
  return {
    payload() {
      return {
        items: items.filter((i) => i.product_id && Number(i.qty) > 0),
        discount, tax,
      };
    },
  };
}

// ------------------------------------------------------------------ router

const ROUTES = [
  { path: "dashboard", title: "Dashboard", icon: "▦", group: "Overview", view: viewDashboard },
  { path: "orders", title: "Orders", icon: "▤", group: "Sales", view: viewOrders },
  { path: "deliveries", title: "Deliveries", icon: "▶", group: "Sales", view: viewDeliveries },
  { path: "invoices", title: "Invoices", icon: "₨", group: "Sales", view: viewInvoices },
  { path: "field", title: "Field Entries", icon: "◎", group: "Sales", view: viewFieldEntries },
  { path: "purchases", title: "Purchases", icon: "▼", group: "Buying", view: viewPurchases },
  { path: "suppliers", title: "Suppliers", icon: "◉", group: "Buying", view: viewSuppliers },
  { path: "products", title: "Products", icon: "◧", group: "Catalogue", view: viewProducts },
  { path: "inventory", title: "Inventory", icon: "▩", group: "Catalogue", view: viewInventory },
  { path: "customers", title: "Customers", icon: "◍", group: "Contacts", view: viewCustomers },
  { path: "accounts", title: "Chart of Accounts", icon: "▤", group: "Accounting", view: viewAccounts },
  { path: "journal", title: "Journal", icon: "✎", group: "Accounting", view: viewJournal },
  { path: "financials", title: "Financial Statements", icon: "▦", group: "Accounting", view: viewFinancials },
  { path: "aging", title: "Aging & Collections", icon: "◔", group: "Accounting", view: viewAging },
  { path: "assets", title: "Fixed Assets", icon: "▣", group: "Accounting", view: viewAssets },
  { path: "reports", title: "Reports", icon: "▧", group: "Insights", view: viewReports },
  { path: "company", title: "Company Profile", icon: "★", group: "Settings", view: viewCompany },
  { path: "users", title: "Users & Access", icon: "◈", group: "Settings", view: viewUsers, adminOnly: true },
];

function buildNav() {
  let html = "";
  let group = null;
  ROUTES.forEach((route) => {
    if (route.adminOnly && state.user.role !== "admin") return;
    if (route.group !== group) {
      group = route.group;
      html += `<div class="nav-group">${h(group)}</div>`;
    }
    html += `<a class="nav-item" data-path="${route.path}" href="#/${route.path}">
      <span class="ico">${route.icon}</span><span>${h(route.title)}</span>
      <span class="nav-badge hidden" data-badge="${route.path}"></span></a>`;
  });
  el("nav").innerHTML = html;
}

function setBadge(path, value) {
  const node = document.querySelector(`[data-badge="${path}"]`);
  if (!node) return;
  node.textContent = value;
  node.classList.toggle("hidden", !value);
}

async function router() {
  const hash = (location.hash || "#/dashboard").replace(/^#\//, "");
  const [path, ...rest] = hash.split("/");
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.path === route.path);
  });
  el("page-title").textContent = route.title;
  el("page-actions").innerHTML = "";
  el("content").innerHTML = `<div class="empty"><div class="big">⏳</div><p>Loading...</p></div>`;
  toggleNav(false);

  try {
    await route.view(rest);
  } catch (err) {
    el("content").innerHTML = err.offline ? offlinePanel() :
      `<div class="card"><div class="card-body">
        <div class="form-error">${h(err.message)}</div></div></div>`;
  }
}

/**
 * Shown in place of a screen when the office cannot be reached. Every screen
 * here reads live figures - stock, money owed, order status - and showing
 * yesterday's numbers as though they were today's would be worse than showing
 * none. So the app says what is happening and offers the part that does work.
 */
function offlinePanel() {
  return `<div class="card"><div class="empty">
    <div class="big">⚡</div>
    <p><strong>No internet connection</strong><br>
      <span class="muted">This screen needs live figures from the office,
      so it cannot load right now. It will come back on its own once you
      are connected.</span></p>
    <div style="display:flex;gap:9px;justify-content:center;flex-wrap:wrap">
      <button class="btn" onclick="location.reload()">Try again</button>
      <a class="btn btn-primary" href="/field.html">Field Booking &mdash; works offline</a>
    </div>
  </div></div>`;
}

function pageAction(label, handler, kind) {
  const button = document.createElement("button");
  button.className = "btn " + (kind || "btn-primary");
  button.textContent = label;
  button.addEventListener("click", handler);
  el("page-actions").appendChild(button);
  return button;
}

function go(path) { location.hash = "#/" + path; }

// --------------------------------------------------------------- dashboard

async function viewDashboard() {
  const data = await api("/dashboard");
  setBadge("deliveries", data.pending_deliveries);
  setBadge("inventory", data.low_stock_count);

  const peak = Math.max(1, ...data.sales_trend.map((d) => d.amount));
  const trend = data.sales_trend.length
    ? `<div class="bars">${data.sales_trend.map((d) => `
        <div class="bar-col" title="${fmtDate(d.d)}: ${cur(d.amount)}">
          <div class="bar" style="height:${Math.max(2, (d.amount / peak) * 115)}px"></div>
          <div class="bar-label">${String(d.d).slice(8)}/${String(d.d).slice(5, 7)}</div>
        </div>`).join("")}</div>`
    : `<p class="muted" style="margin:0">No invoices in the last 14 days.</p>`;

  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat green"><div class="label">Sales this month</div>
        <div class="value">${cur(data.sales_month)}</div>
        <div class="sub">Invoiced since ${fmtDate(monthStart())}</div></div>
      <div class="stat blue"><div class="label">Purchases this month</div>
        <div class="value">${cur(data.purchases_month)}</div>
        <div class="sub">Goods bought in</div></div>
      <div class="stat amber"><div class="label">Receivables</div>
        <div class="value">${cur(data.receivables)}</div>
        <div class="sub">Owed by customers</div></div>
      <div class="stat"><div class="label">Payables</div>
        <div class="value">${cur(data.payables)}</div>
        <div class="sub">Owed to suppliers</div></div>
    </div>

    <div class="stat-grid">
      <div class="stat blue"><div class="label">Stock value</div>
        <div class="value">${cur(data.stock_value)}</div>
        <div class="sub">${data.products} active items</div></div>
      <div class="stat amber"><div class="label">Open orders</div>
        <div class="value">${data.open_orders}</div>
        <div class="sub">${data.pending_deliveries} awaiting delivery</div></div>
      <div class="stat ${data.low_stock_count ? "" : "green"}"><div class="label">Low stock alerts</div>
        <div class="value">${data.low_stock_count}</div>
        <div class="sub">At or below reorder level</div></div>
      <div class="stat green"><div class="label">Contacts</div>
        <div class="value">${data.customers} / ${data.suppliers}</div>
        <div class="sub">Customers / suppliers</div></div>
    </div>

    <div class="card"><div class="card-head"><h2>Sales - last 14 days</h2></div>
      <div class="card-body">${trend}</div></div>

    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Recent orders</h2>
        <button class="btn btn-sm" onclick="location.hash='#/orders'">View all</button></div>
        <div class="card-body flush"><div class="table-wrap"><table class="data">
          <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th class="num">Total</th></tr></thead>
          <tbody>${data.recent_orders.length ? data.recent_orders.map((o) => `
            <tr style="cursor:pointer" onclick="location.hash='#/orders/${o.id}'">
              <td class="mono strong">${h(o.order_no)}<div class="muted">${fmtDate(o.order_date)}</div></td>
              <td>${h(o.customer_name)}</td>
              <td>${statusBadge(o.status)}<div style="margin-top:3px">${statusBadge(o.delivery_status)}</div></td>
              <td class="num strong">${money(o.total)}</td></tr>`).join("")
            : `<tr><td colspan="4" class="empty">No orders yet.</td></tr>`}
          </tbody></table></div></div></div>

      <div class="card"><div class="card-head"><h2>Needs reordering</h2>
        <button class="btn btn-sm" onclick="location.hash='#/inventory'">Inventory</button></div>
        <div class="card-body flush"><div class="table-wrap"><table class="data">
          <thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reorder at</th></tr></thead>
          <tbody>${data.low_stock.length ? data.low_stock.map((p) => `
            <tr><td><span class="mono muted">${h(p.sku)}</span> ${h(p.name)}</td>
              <td class="num strong" style="color:var(--brand)">${qty(p.stock)} ${h(p.unit)}</td>
              <td class="num muted">${qty(p.reorder_level)}</td></tr>`).join("")
            : `<tr><td colspan="3" class="empty">Everything is above its reorder level.</td></tr>`}
          </tbody></table></div></div></div>
    </div>`;
}

// ------------------------------------------------------------------ orders

async function viewOrders(rest) {
  if (rest[0] === "new") return orderForm(null);
  if (rest[0] === "edit" && rest[1]) return orderForm(rest[1]);
  if (rest[0]) return orderDetail(rest[0]);

  await loadMasters();
  pageAction("+ New Order", () => go("orders/new"));

  const filters = { q: "", status: "", delivery_status: "" };
  async function refresh() {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    const orders = await api("/orders?" + params);
    $("#orders-body").innerHTML = orders.length ? orders.map((o) => `
      <tr>
        <td class="mono strong"><a href="#/orders/${o.id}">${h(o.order_no)}</a></td>
        <td>${fmtDate(o.order_date)}</td>
        <td>${h(o.customer_name)}<div class="muted">${h(o.customer_city)}</div></td>
        <td>${statusBadge(o.status)}</td>
        <td>${statusBadge(o.delivery_status)}</td>
        <td class="num strong">${money(o.total)}</td>
        <td>${o.invoice_no ? `<span class="mono">${h(o.invoice_no)}</span>` : `<span class="muted">-</span>`}</td>
        <td class="row-actions"><a class="btn btn-sm" href="#/orders/${o.id}">Open</a></td>
      </tr>`).join("")
      : `<tr><td colspan="8">${emptyState("▤", "No orders match", "Adjust the filters or create a new order.")}</td></tr>`;
  }

  el("content").innerHTML = `
    <div class="toolbar">
      <input class="search" id="f-q" placeholder="Search order number or customer...">
      <select id="f-status"><option value="">All statuses</option>
        ${["Pending", "Confirmed", "Delivered", "Cancelled"].map((s) => `<option>${s}</option>`).join("")}</select>
      <select id="f-delivery"><option value="">All deliveries</option>
        ${["Not Dispatched", "Packed", "Dispatched", "In Transit", "Delivered", "Returned"].map((s) => `<option>${s}</option>`).join("")}</select>
    </div>
    ${tableCard(`<th>Order #</th><th>Date</th><th>Customer</th><th>Status</th><th>Delivery</th>
       <th class="num">Total</th><th>Invoice</th><th></th>`, `<tr><td colspan="8" class="empty">Loading...</td></tr>`)}`;
  $("table.data tbody").id = "orders-body";

  let timer;
  $("#f-q").addEventListener("input", (e) => {
    filters.q = e.target.value;
    clearTimeout(timer); timer = setTimeout(refresh, 250);
  });
  $("#f-status").addEventListener("change", (e) => { filters.status = e.target.value; refresh(); });
  $("#f-delivery").addEventListener("change", (e) => { filters.delivery_status = e.target.value; refresh(); });
  refresh();
}

async function orderForm(orderId) {
  await loadMasters();
  let order = { order_date: today(), status: "Pending", delivery_status: "Not Dispatched" };
  let items = [];
  if (orderId) {
    const data = await api("/orders/" + orderId);
    order = data.order;
    items = data.items;
  }
  if (!state.customers.length) {
    el("content").innerHTML = `<div class="card">${emptyState("◍", "Add a customer first",
      "An order needs a customer. Create one, then come back.",
      `<button class="btn btn-primary" onclick="location.hash='#/customers'">Go to Customers</button>`)}</div>`;
    return;
  }

  el("page-title").textContent = orderId ? "Edit Order " + order.order_no : "New Order";
  el("content").innerHTML = `
    <form id="order-form">
      <div class="card"><div class="card-body">
        <div class="form-error hidden" id="order-error"></div>
        <div class="field-row">
          <label class="field">Customer *
            <select name="customer_id" required>
              <option value="">Select a customer...</option>
              ${options(state.customers, order.customer_id)}
            </select></label>
          <label class="field">Order date *
            <input type="date" name="order_date" value="${h(order.order_date)}" required></label>
          <label class="field">Expected delivery
            <input type="date" name="delivery_date" value="${h(order.delivery_date || "")}"></label>
        </div>
        <div class="field-row">
          <label class="field">Order status
            <select name="status">${["Pending", "Confirmed", "Delivered", "Cancelled"]
              .map((s) => `<option ${s === order.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label class="field">Delivery status
            <select name="delivery_status">${["Not Dispatched", "Packed", "Dispatched", "In Transit", "Delivered", "Returned"]
              .map((s) => `<option ${s === order.delivery_status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label class="field">Delivery note / tracking
            <input name="tracking_note" value="${h(order.tracking_note || "")}" placeholder="Driver, vehicle, bilty no."></label>
        </div>
      </div></div>

      <div class="card"><div class="card-head"><h2>Items</h2>
        <span class="muted">Stock is deducted when the order is marked Delivered</span></div>
        <div class="card-body"><div id="items"></div></div></div>

      <div class="card"><div class="card-body">
        <label class="field">Notes<textarea name="notes" placeholder="Any instructions for this order">${h(order.notes || "")}</textarea></label>
      </div></div>

      <div class="toolbar" style="justify-content:flex-end">
        <button type="button" class="btn" id="cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">${orderId ? "Save Changes" : "Create Order"}</button>
      </div>
    </form>`;

  const editor = ItemEditor(el("items"), {
    items, discount: order.discount, tax: order.tax,
    priceField: "sale_price", checkStock: true,
  });
  $("#cancel-btn").addEventListener("click", () => go(orderId ? "orders/" + orderId : "orders"));

  $("#order-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', e.target);
    const errorBox = $("#order-error");
    button.disabled = true;
    try {
      const payload = Object.assign(formValues(e.target), editor.payload());
      if (!payload.items.length) throw new Error("Add at least one item to the order.");
      const result = orderId
        ? await api("/orders/" + orderId, { method: "PUT", body: payload })
        : await api("/orders", { method: "POST", body: payload });
      toast(orderId ? "Order updated." : "Order " + result.order_no + " created.", "success");
      go("orders/" + (orderId || result.id));
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
      button.disabled = false;
      window.scrollTo(0, 0);
    }
  });
}

async function orderDetail(orderId) {
  const data = await api("/orders/" + orderId);
  const { order, items, invoice } = data;

  el("page-title").textContent = "Order " + order.order_no;
  if (!invoice && order.status !== "Cancelled") {
    pageAction("Generate Invoice", async () => {
      try {
        const result = await api(`/orders/${orderId}/invoice`, { method: "POST", body: { invoice_date: today() } });
        toast("Invoice created.", "success");
        go("invoices/" + result.id);
      } catch (err) { toast(err.offline ? "No connection - try again once you are online." : err.message, "error"); }
    });
  }
  if (!invoice) pageAction("Edit", () => go("orders/edit/" + orderId), "btn");
  pageAction("Update Delivery", () => deliveryModal(order, () => router()), "btn");

  el("content").innerHTML = `
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Order details</h2>${statusBadge(order.status)}</div>
        <div class="card-body">
          <div class="field-row" style="margin:0">
            <div><div class="muted">Customer</div><div class="strong">${h(order.customer_name)}</div>
              <div class="muted">${h(order.customer_address || "")} ${h(order.customer_city || "")}</div>
              <div class="muted">${h(order.customer_phone || "")}</div></div>
            <div><div class="muted">Order date</div><div class="strong">${fmtDate(order.order_date)}</div>
              <div class="muted" style="margin-top:8px">Expected delivery</div>
              <div class="strong">${fmtDate(order.delivery_date)}</div></div>
          </div>
          ${order.notes ? `<p class="muted" style="margin-top:14px">${h(order.notes)}</p>` : ""}
        </div></div>

      <div class="card"><div class="card-head"><h2>Delivery tracking</h2>${statusBadge(order.delivery_status)}</div>
        <div class="card-body">
          <div class="muted">Current stage</div>
          <div class="strong" style="font-size:16px;margin-bottom:10px">${h(order.delivery_status)}</div>
          <div class="muted">Note</div>
          <div>${h(order.tracking_note) || `<span class="muted">No delivery note recorded.</span>`}</div>
          <div style="margin-top:14px">${order.stock_applied
            ? `<span class="badge green">Stock deducted</span>`
            : `<span class="badge grey">Stock not yet deducted</span>`}
            ${invoice ? ` <span class="badge blue">Invoiced: ${h(invoice.invoice_no)}</span>` : ""}</div>
        </div></div>
    </div>

    <div class="card"><div class="card-head"><h2>Items</h2></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td><span class="mono muted">${h(i.sku)}</span> ${h(i.product_name)}</td>
          <td class="num">${qty(i.qty)} ${h(i.unit)}</td>
          <td class="num">${money(i.price)}</td>
          <td class="num strong">${money(i.line_total)}</td></tr>`).join("")}
        </tbody></table></div>
        <div style="padding:16px"><div class="totals">
          <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
          <div><span>Discount</span><span>- ${money(order.discount)}</span></div>
          <div><span>Tax</span><span>${money(order.tax)}</span></div>
          <div class="grand"><span>Total</span><span>${cur(order.total)}</span></div>
        </div></div>
      </div></div>

    <div class="toolbar">
      <button class="btn" onclick="location.hash='#/orders'">&larr; Back to orders</button>
      ${invoice ? `<button class="btn" onclick="location.hash='#/invoices/${invoice.id}'">View invoice</button>` : ""}
      <span style="flex:1"></span>
      <button class="btn btn-danger" id="del-order">Delete order</button>
    </div>`;

  $("#del-order").addEventListener("click", () => confirmDialog(
    `Delete order ${order.order_no}? Any stock it moved will be returned.`,
    async () => {
      closeModal();
      deleteWithCascade("/orders/" + orderId, "Order", () => go("orders"));
    }, "Delete order"));
}

function deliveryModal(order, onDone) {
  const stages = ["Not Dispatched", "Packed", "Dispatched", "In Transit", "Delivered", "Returned"];
  modal({
    title: "Update delivery - " + order.order_no,
    body: `
      <div class="field-row">
        <label class="field">Delivery stage
          <select name="delivery_status">${stages.map((s) =>
            `<option ${s === order.delivery_status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field">Order status
          <select name="status">${["Pending", "Confirmed", "Delivered", "Cancelled"].map((s) =>
            `<option ${s === order.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      </div>
      <label class="field">Delivery note / tracking
        <input name="tracking_note" value="${h(order.tracking_note || "")}" placeholder="Driver name, vehicle or bilty number"></label>
      <p class="muted" style="margin:14px 0 0;font-size:12.5px">
        Marking the order <strong>Delivered</strong> deducts the items from stock.
        Moving it back out of Delivered returns them.</p>`,
    submitLabel: "Update",
    onSubmit: async (form) => {
      await api(`/orders/${order.id}/status`, { method: "POST", body: formValues(form) });
      toast("Delivery updated.", "success");
      onDone();
    },
  });
}

// ------------------------------------------------------------ field entries

async function viewFieldEntries() {
  const entries = await api("/field/entries");
  const pending = entries.filter((e) => e.status === "Pending");
  setBadge("field", pending.length);

  pageAction("Open Field Form", () => window.open("/field.html", "_blank"), "btn");

  const card = (e) => `
    <tr>
      <td>
        <span class="strong">${h(e.party_name)}</span>
        <div class="muted">${h(e.city) || "-"}${e.phone ? " &middot; " + h(e.phone) : ""}</div>
      </td>
      <td>${statusBadge(e.kind === "Purchase" ? "Ordered" : "Pending").replace(
             e.kind === "Purchase" ? "Ordered" : "Pending", h(e.kind))}</td>
      <td>${fmtDate(e.entry_date)}<div class="muted">by ${h(e.device) || "field"}</div></td>
      <td>${e.items.map((i) => `${h(i.sku)} &times; ${qty(i.qty)}`).join("<br>") || "-"}</td>
      <td class="num strong">${money(e.total)}</td>
      <td>${e.status === "Converted"
            ? `<span class="badge green">${h(e.linked_no)}</span>`
            : e.status === "Rejected"
              ? `<span class="badge grey">Rejected</span>`
              : `<span class="badge amber">Pending</span>`}</td>
      <td class="row-actions">${e.status === "Pending"
        ? `<button class="btn btn-sm btn-primary" data-convert="${e.id}">Accept</button>
           <button class="btn btn-sm" data-reject="${e.id}">Reject</button>` : ""}
        <button class="btn btn-sm btn-danger" data-delentry="${e.id}">Delete</button></td>
    </tr>`;

  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat amber"><div class="label">Waiting for review</div>
        <div class="value">${pending.length}</div>
        <div class="sub">Sent in from the field</div></div>
      <div class="stat green"><div class="label">Accepted</div>
        <div class="value">${entries.filter((e) => e.status === "Converted").length}</div>
        <div class="sub">Turned into orders or purchases</div></div>
      <div class="stat blue"><div class="label">Value waiting</div>
        <div class="value">${cur(pending.reduce((s, e) => s + Number(e.total), 0))}</div></div>
    </div>

    <div class="card"><div class="card-body">
      <p style="margin:0" class="muted">Your buyer opens
        <strong>/field.html</strong> on their phone. It works with no signal &mdash; entries are
        held on the device and appear here automatically once they are back in range.</p>
    </div></div>

    ${tableCard(`<th>Shop / party</th><th>Type</th><th>Date</th><th>Items</th>
       <th class="num">Total</th><th>Status</th><th></th>`,
      entries.length ? entries.map(card).join("") : null,
      emptyState("◎", "Nothing from the field yet",
        "Entries saved on a phone appear here as soon as it reconnects.",
        `<button class="btn btn-primary" onclick="window.open('/field.html','_blank')">Open the field form</button>`))}`;

  document.querySelectorAll("[data-convert]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const result = await api(`/field/entries/${b.dataset.convert}/convert`, { method: "POST" });
      toast(`Accepted as ${result.number}.`, "success");
      state.products = [];
      viewFieldEntries();
    } catch (err) { toast(err.message, "error"); b.disabled = false; }
  }));
  document.querySelectorAll("[data-delentry]").forEach((b) => b.addEventListener("click", () => {
    confirmDialog("Delete this field entry permanently?", async () => {
      await api(`/field/entries/${b.dataset.delentry}`, { method: "DELETE" });
      toast("Entry deleted.", "success");
      viewFieldEntries();
    }, "Delete entry");
  }));
  document.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => {
    confirmDialog("Reject this field entry?", async () => {
      await api(`/field/entries/${b.dataset.reject}/reject`, { method: "POST" });
      toast("Entry rejected.", "success");
      viewFieldEntries();
    }, "Reject");
  }));
}

// -------------------------------------------------------------- deliveries

async function viewDeliveries() {
  const orders = await api("/orders");
  const pending = orders.filter((o) => o.status !== "Cancelled"
    && !["Delivered", "Returned"].includes(o.delivery_status));
  const done = orders.filter((o) => ["Delivered", "Returned"].includes(o.delivery_status)).slice(0, 25);
  setBadge("deliveries", pending.length);

  const row = (o) => `<tr>
    <td class="mono strong"><a href="#/orders/${o.id}">${h(o.order_no)}</a></td>
    <td>${h(o.customer_name)}<div class="muted">${h(o.customer_city || "")}</div></td>
    <td>${fmtDate(o.order_date)}</td>
    <td>${o.delivery_date ? fmtDate(o.delivery_date) : `<span class="muted">Not set</span>`}</td>
    <td>${statusBadge(o.delivery_status)}</td>
    <td class="num">${money(o.total)}</td>
    <td class="row-actions"><button class="btn btn-sm" data-update="${o.id}">Update</button></td></tr>`;

  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat amber"><div class="label">Awaiting delivery</div>
        <div class="value">${pending.length}</div><div class="sub">Orders still in transit or unpacked</div></div>
      <div class="stat green"><div class="label">Completed</div>
        <div class="value">${orders.filter((o) => o.delivery_status === "Delivered").length}</div>
        <div class="sub">Delivered to customers</div></div>
      <div class="stat"><div class="label">Returned</div>
        <div class="value">${orders.filter((o) => o.delivery_status === "Returned").length}</div>
        <div class="sub">Sent back by customers</div></div>
    </div>

    <div class="card"><div class="card-head"><h2>Pending deliveries</h2></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Order</th><th>Customer</th><th>Ordered</th><th>Expected</th>
          <th>Stage</th><th class="num">Value</th><th></th></tr></thead>
        <tbody>${pending.length ? pending.map(row).join("")
          : `<tr><td colspan="7">${emptyState("✔", "Nothing pending", "Every order has been delivered or returned.")}</td></tr>`}
        </tbody></table></div></div></div>

    <div class="card"><div class="card-head"><h2>Recently completed</h2></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Order</th><th>Customer</th><th>Ordered</th><th>Expected</th>
          <th>Stage</th><th class="num">Value</th><th></th></tr></thead>
        <tbody>${done.length ? done.map(row).join("")
          : `<tr><td colspan="7" class="empty">No completed deliveries yet.</td></tr>`}
        </tbody></table></div></div></div>`;

  document.querySelectorAll("[data-update]").forEach((button) => {
    button.addEventListener("click", () => {
      const order = orders.find((o) => String(o.id) === button.dataset.update);
      deliveryModal(order, () => router());
    });
  });
}

// ---------------------------------------------------------------- invoices

async function viewInvoices(rest) {
  if (rest[0] === "new") return invoiceForm();
  if (rest[0]) return invoiceDetail(rest[0]);

  await loadMasters();
  pageAction("+ Direct Invoice", () => go("invoices/new"));

  const filters = { q: "", status: "" };
  async function refresh() {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    const invoices = await api("/invoices?" + params);
    const outstanding = invoices.reduce((sum, i) => sum + Number(i.balance || 0), 0);
    $("#inv-total").textContent = cur(invoices.reduce((s, i) => s + Number(i.total), 0));
    $("#inv-due").textContent = cur(outstanding);
    $("#invoices-body").innerHTML = invoices.length ? invoices.map((i) => `
      <tr>
        <td class="mono strong"><a href="#/invoices/${i.id}">${h(i.invoice_no)}</a>
          ${i.order_no ? `<div class="muted mono">${h(i.order_no)}</div>` : ""}</td>
        <td>${fmtDate(i.invoice_date)}</td>
        <td>${h(i.customer_name)}</td>
        <td class="num">${money(i.total)}</td>
        <td class="num">${money(i.paid)}</td>
        <td class="num ${i.balance > 0 ? "strong" : "muted"}" ${i.balance > 0 ? 'style="color:var(--brand)"' : ""}>${money(i.balance)}</td>
        <td>${statusBadge(i.status)}</td>
        <td class="row-actions"><a class="btn btn-sm" href="#/invoices/${i.id}">Open</a></td>
      </tr>`).join("")
      : `<tr><td colspan="8">${emptyState("₨", "No invoices yet", "Generate one from an order, or create a direct invoice.")}</td></tr>`;
  }

  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat green"><div class="label">Invoiced (filtered)</div><div class="value" id="inv-total">-</div></div>
      <div class="stat amber"><div class="label">Outstanding</div><div class="value" id="inv-due">-</div></div>
    </div>
    <div class="toolbar">
      <input class="search" id="f-q" placeholder="Search invoice number or customer...">
      <select id="f-status"><option value="">All</option>
        ${["Unpaid", "Partial", "Paid"].map((s) => `<option>${s}</option>`).join("")}</select>
    </div>
    ${tableCard(`<th>Invoice #</th><th>Date</th><th>Customer</th><th class="num">Total</th>
      <th class="num">Paid</th><th class="num">Balance</th><th>Status</th><th></th>`,
      `<tr><td colspan="8" class="empty">Loading...</td></tr>`)}`;
  $("table.data tbody").id = "invoices-body";

  let timer;
  $("#f-q").addEventListener("input", (e) => {
    filters.q = e.target.value; clearTimeout(timer); timer = setTimeout(refresh, 250);
  });
  $("#f-status").addEventListener("change", (e) => { filters.status = e.target.value; refresh(); });
  refresh();
}

async function invoiceForm() {
  await loadMasters();
  if (!state.customers.length) {
    el("content").innerHTML = `<div class="card">${emptyState("◍", "Add a customer first",
      "An invoice needs a customer.",
      `<button class="btn btn-primary" onclick="location.hash='#/customers'">Go to Customers</button>`)}</div>`;
    return;
  }
  el("page-title").textContent = "Direct Invoice";
  el("content").innerHTML = `
    <form id="invoice-form">
      <div class="card"><div class="card-body">
        <div class="form-error hidden" id="inv-error"></div>
        <p class="muted" style="margin-top:0">A direct invoice is a counter sale with no order behind it.
          Stock is deducted as soon as you save.</p>
        <div class="field-row">
          <label class="field">Customer *
            <select name="customer_id" required><option value="">Select a customer...</option>
              ${options(state.customers)}</select></label>
          <label class="field">Invoice date *<input type="date" name="invoice_date" value="${today()}" required></label>
          <label class="field">Due date<input type="date" name="due_date"></label>
          <label class="field">Amount received<input type="number" step="0.01" min="0" name="paid" value="0"></label>
        </div>
      </div></div>
      <div class="card"><div class="card-head"><h2>Items</h2></div>
        <div class="card-body"><div id="items"></div></div></div>
      <div class="card"><div class="card-body">
        <label class="field">Notes<textarea name="notes"></textarea></label></div></div>
      <div class="toolbar" style="justify-content:flex-end">
        <button type="button" class="btn" onclick="location.hash='#/invoices'">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Invoice</button>
      </div>
    </form>`;

  const editor = ItemEditor(el("items"), { priceField: "sale_price", checkStock: true });
  $("#invoice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', e.target);
    button.disabled = true;
    try {
      const payload = Object.assign(formValues(e.target), editor.payload());
      if (!payload.items.length) throw new Error("Add at least one item.");
      const result = await api("/invoices", { method: "POST", body: payload });
      toast("Invoice " + result.invoice_no + " created.", "success");
      go("invoices/" + result.id);
    } catch (err) {
      const box = $("#inv-error");
      box.textContent = err.message; box.classList.remove("hidden");
      button.disabled = false; window.scrollTo(0, 0);
    }
  });
}

async function invoiceDetail(invoiceId) {
  const data = await api("/invoices/" + invoiceId);
  const { invoice, items, company } = data;
  el("page-title").textContent = "Invoice " + invoice.invoice_no;

  pageAction("Print / PDF", () => {
    el("print-root").innerHTML = invoiceDocument(invoice, items, company);
    fitToOnePage(el("print-root"));
    window.print();
  });
  if (invoice.total > invoice.paid) {
    pageAction("Record Payment", () => paymentModal(invoice), "btn");
  }

  el("content").innerHTML = `
    <div class="card"><div class="card-body" style="padding:0">
      ${invoiceDocument(invoice, items, company)}
    </div></div>
    <div class="toolbar">
      <button class="btn" onclick="location.hash='#/invoices'">&larr; Back to invoices</button>
      ${invoice.order_id ? `<button class="btn" onclick="location.hash='#/orders/${invoice.order_id}'">View order</button>` : ""}
      <span style="flex:1"></span>
      <button class="btn btn-danger" id="del-inv">Delete invoice</button>
    </div>`;

  const deleteButton = $("#del-inv");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => confirmDialog(
      `Delete invoice ${invoice.invoice_no}? This cannot be undone.`,
      async () => {
        await api("/invoices/" + invoiceId, { method: "DELETE" });
        toast("Invoice deleted.", "success");
        go("invoices");
      }, "Delete invoice"));
  }
}

/**
 * Guarantees one page. The density classes get the document close; this
 * measures what they actually produced at A4 width and scales the result so it
 * lands inside a single sheet however many lines there are. Measuring is the
 * only reliable way - a long item description or a long shop name changes the
 * height as much as the row count does.
 */
const A4_CONTENT_WIDTH = 703;   // 210mm - 12mm margins, at 96dpi
const A4_CONTENT_HEIGHT = 1032; // 297mm - 12mm margins

function fitToOnePage(root) {
  const doc = root.querySelector(".doc");
  if (!doc) return;
  doc.style.zoom = "";
  // measure off-screen at the real paper width, then hide it again
  const previous = root.getAttribute("style") || "";
  root.setAttribute("style",
    "display:block;position:fixed;left:-10000px;top:0;width:" + A4_CONTENT_WIDTH + "px");
  const height = doc.getBoundingClientRect().height;
  root.setAttribute("style", previous);
  // Aim at 94% of the sheet. Measuring here and printing later are not
  // identical - the print engine rounds, and fonts hint differently at print
  // resolution - so a document measured at exactly one page still spills.
  // The headroom costs a little white space and removes the second sheet.
  const target = A4_CONTENT_HEIGHT * 0.94;
  if (height > target) {
    doc.style.zoom = (target / height).toFixed(4);
  }
}

function invoiceDensity(count) {
  if (count <= 4) return " doc-short";   // a two-line bill should not fill a sheet
  if (count <= 8) return "";
  if (count <= 14) return " doc-tight";
  if (count <= 28) return " doc-dense";
  return " doc-packed";                  // as small as stays readable
}

function invoiceDocument(invoice, items, company) {
  return `<div class="doc${invoiceDensity(items.length)}">
    <div class="doc-head">
      ${company.logo ? `<img class="doc-logo" src="${h(company.logo)}" alt="">` : ""}
      <div class="doc-company">
        <h2>${h(company.name)}</h2>
        ${company.tagline ? `<p>${h(company.tagline)}</p>` : ""}
        ${company.address ? `<p>${h(company.address)}</p>` : ""}
        <p>${[company.city, company.phone].filter(Boolean).map(h).join(" &middot; ")}</p>
        <p>${[company.email, company.website].filter(Boolean).map(h).join(" &middot; ")}</p>
        ${company.tax_id ? `<p>NTN: ${h(company.tax_id)}</p>` : ""}
      </div>
      <div class="doc-title">
        <h3>Invoice</h3>
        <p><strong>${h(invoice.invoice_no)}</strong></p>
        <p>Date: ${fmtDate(invoice.invoice_date)}</p>
        ${invoice.due_date ? `<p>Due: ${fmtDate(invoice.due_date)}</p>` : ""}
        ${invoice.order_no ? `<p>Order: ${h(invoice.order_no)}</p>` : ""}
        <p style="margin-top:6px">${statusBadge(invoice.status)}</p>
      </div>
    </div>

    <div class="doc-parties">
      <div><h4>Billed to</h4>
        <p><strong>${h(invoice.customer_name)}</strong></p>
        ${invoice.customer_contact ? `<p>${h(invoice.customer_contact)}</p>` : ""}
        ${invoice.customer_address ? `<p>${h(invoice.customer_address)}</p>` : ""}
        <p>${[invoice.customer_city, invoice.customer_phone].filter(Boolean).map(h).join(" &middot; ")}</p>
        ${invoice.customer_tax_id ? `<p>NTN: ${h(invoice.customer_tax_id)}</p>` : ""}
      </div>
      <div style="text-align:right">
        <h4>Amount due</h4>
        <p style="font-size:24px;font-weight:700;color:var(--brand)">
          ${(company.currency || "PKR")} ${money(invoice.total - invoice.paid)}</p>
        <p class="muted">Paid: ${money(invoice.paid)} of ${money(invoice.total)}</p>
      </div>
    </div>

    <table class="doc-table">
      <thead><tr><th style="width:38px">#</th><th>Description</th><th>Code</th>
        <th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${items.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${h(item.product_name)}${item.pack_size ? `<br><span class="muted" style="font-size:11px">${h(item.pack_size)}</span>` : ""}</td>
        <td class="mono">${h(item.sku)}</td>
        <td class="num">${qty(item.qty)} ${h(item.unit)}</td>
        <td class="num">${money(item.price)}</td>
        <td class="num"><strong>${money(item.line_total)}</strong></td></tr>`).join("")}
      </tbody>
    </table>

    <div style="padding-top:14px"><div class="totals">
      <div><span>Subtotal</span><span>${money(invoice.subtotal)}</span></div>
      <div><span>Discount</span><span>- ${money(invoice.discount)}</span></div>
      <div><span>Tax</span><span>${money(invoice.tax)}</span></div>
      <div class="grand"><span>Total</span><span>${(company.currency || "PKR")} ${money(invoice.total)}</span></div>
      <div><span>Received</span><span>${money(invoice.paid)}</span></div>
      <div class="grand"><span>Balance</span><span>${(company.currency || "PKR")} ${money(invoice.total - invoice.paid)}</span></div>
    </div></div>

    ${invoice.notes ? `<p style="margin-top:20px;font-size:12px"><strong>Notes:</strong> ${h(invoice.notes)}</p>` : ""}

    <div class="doc-sign"><div>Customer Signature</div><div>For ${h(company.name)}</div></div>
    <div class="doc-foot">${h(company.footer || "")}</div>
  </div>`;
}

function paymentModal(invoice) {
  const due = invoice.total - invoice.paid;
  modal({
    title: "Record payment - " + invoice.invoice_no,
    body: `
      <p class="muted" style="margin-top:0">Outstanding balance: <strong>${cur(due)}</strong></p>
      <label class="field">Amount received
        <input type="number" step="0.01" min="0" max="${due}" name="amount" value="${due.toFixed(2)}" required></label>`,
    submitLabel: "Record payment",
    onSubmit: async (form) => {
      await api(`/invoices/${invoice.id}/payment`, { method: "POST", body: formValues(form) });
      toast("Payment recorded.", "success");
      router();
    },
  });
}

// --------------------------------------------------------------- purchases

async function viewPurchases(rest) {
  if (rest[0] === "new") return purchaseForm();
  if (rest[0]) return purchaseDetail(rest[0]);

  await loadMasters();
  pageAction("+ Record Purchase", () => go("purchases/new"));

  const purchases = await api("/purchases");
  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat blue"><div class="label">Total purchased</div>
        <div class="value">${cur(purchases.reduce((s, p) => s + Number(p.total), 0))}</div></div>
      <div class="stat amber"><div class="label">Unpaid to suppliers</div>
        <div class="value">${cur(purchases.reduce((s, p) => s + Number(p.balance), 0))}</div></div>
    </div>
    ${tableCard(`<th>Purchase #</th><th>Date</th><th>Supplier</th><th>Bill #</th>
      <th class="num">Total</th><th class="num">Balance</th><th>Status</th><th></th>`,
      purchases.length ? purchases.map((p) => `<tr>
        <td class="mono strong"><a href="#/purchases/${p.id}">${h(p.purchase_no)}</a></td>
        <td>${fmtDate(p.purchase_date)}</td>
        <td>${h(p.supplier_name)}</td>
        <td class="mono muted">${h(p.bill_no) || "-"}</td>
        <td class="num">${money(p.total)}</td>
        <td class="num ${p.balance > 0 ? "strong" : "muted"}">${money(p.balance)}</td>
        <td>${statusBadge(p.status)}</td>
        <td class="row-actions"><a class="btn btn-sm" href="#/purchases/${p.id}">Open</a></td>
      </tr>`).join("")
      : null,
      emptyState("▼", "No purchases recorded", "Record a purchase to bring stock in.",
        `<button class="btn btn-primary" onclick="location.hash='#/purchases/new'">Record Purchase</button>`))}`;
}

async function purchaseForm() {
  await loadMasters();
  if (!state.suppliers.length) {
    el("content").innerHTML = `<div class="card">${emptyState("◉", "Add a supplier first",
      "A purchase needs a supplier.",
      `<button class="btn btn-primary" onclick="location.hash='#/suppliers'">Go to Suppliers</button>`)}</div>`;
    return;
  }
  el("page-title").textContent = "Record Purchase";
  el("content").innerHTML = `
    <form id="purchase-form">
      <div class="card"><div class="card-body">
        <div class="form-error hidden" id="pur-error"></div>
        <div class="field-row">
          <label class="field">Supplier *
            <select name="supplier_id" required><option value="">Select a supplier...</option>
              ${options(state.suppliers)}</select></label>
          <label class="field">Purchase date *<input type="date" name="purchase_date" value="${today()}" required></label>
          <label class="field">Supplier bill #<input name="bill_no" placeholder="Their invoice number"></label>
          <label class="field">Amount paid<input type="number" step="0.01" min="0" name="paid" value="0"></label>
        </div>
        <div class="field-row" style="margin-bottom:0">
          <label class="field">Status
            <select name="status"><option>Received</option><option>Ordered</option></select>
          </label>
          <div style="display:flex;align-items:flex-end">
            <label class="checkbox"><input type="checkbox" name="update_cost" checked>
              Update each item's cost price to the rate entered here</label>
          </div>
        </div>
      </div></div>
      <div class="card"><div class="card-head"><h2>Items received</h2>
        <span class="muted">Marking this "Received" adds the quantities to stock</span></div>
        <div class="card-body"><div id="items"></div></div></div>
      <div class="card"><div class="card-body">
        <label class="field">Notes<textarea name="notes"></textarea></label></div></div>
      <div class="toolbar" style="justify-content:flex-end">
        <button type="button" class="btn" onclick="location.hash='#/purchases'">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Purchase</button>
      </div>
    </form>`;

  const editor = ItemEditor(el("items"), { priceField: "purchase_price", showStock: true });
  $("#purchase-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', e.target);
    button.disabled = true;
    try {
      const payload = Object.assign(formValues(e.target), editor.payload());
      if (!payload.items.length) throw new Error("Add at least one item.");
      const result = await api("/purchases", { method: "POST", body: payload });
      toast("Purchase " + result.purchase_no + " saved.", "success");
      state.products = [];
      go("purchases/" + result.id);
    } catch (err) {
      const box = $("#pur-error");
      box.textContent = err.message; box.classList.remove("hidden");
      button.disabled = false; window.scrollTo(0, 0);
    }
  });
}

async function purchaseDetail(purchaseId) {
  const { purchase, items } = await api("/purchases/" + purchaseId);
  el("page-title").textContent = "Purchase " + purchase.purchase_no;

  if (!purchase.stock_applied) {
    pageAction("Receive into Stock", async () => {
      await api(`/purchases/${purchaseId}/receive`, { method: "POST" });
      toast("Stock received.", "success");
      state.products = [];
      router();
    });
  }
  if (purchase.total > purchase.paid) {
    pageAction("Record Payment", () => {
      const due = purchase.total - purchase.paid;
      modal({
        title: "Pay supplier - " + purchase.purchase_no,
        body: `<p class="muted" style="margin-top:0">Outstanding: <strong>${cur(due)}</strong></p>
          <label class="field">Amount paid
            <input type="number" step="0.01" min="0" max="${due}" name="amount" value="${due.toFixed(2)}" required></label>`,
        submitLabel: "Record payment",
        onSubmit: async (form) => {
          await api(`/purchases/${purchaseId}/payment`, { method: "POST", body: formValues(form) });
          toast("Payment recorded.", "success");
          router();
        },
      });
    }, "btn");
  }

  el("content").innerHTML = `
    <div class="card"><div class="card-head"><h2>Purchase details</h2>${statusBadge(purchase.status)}
      ${purchase.stock_applied ? `<span class="badge green">In stock</span>` : `<span class="badge amber">Not received</span>`}</div>
      <div class="card-body"><div class="field-row" style="margin:0">
        <div><div class="muted">Supplier</div><div class="strong">${h(purchase.supplier_name)}</div>
          <div class="muted">${h(purchase.supplier_address || "")} ${h(purchase.supplier_city || "")}</div>
          <div class="muted">${h(purchase.supplier_phone || "")}</div></div>
        <div><div class="muted">Purchase date</div><div class="strong">${fmtDate(purchase.purchase_date)}</div>
          <div class="muted" style="margin-top:8px">Supplier bill #</div>
          <div class="strong mono">${h(purchase.bill_no) || "-"}</div></div>
        <div><div class="muted">Paid</div><div class="strong">${cur(purchase.paid)}</div>
          <div class="muted" style="margin-top:8px">Balance</div>
          <div class="strong" style="color:var(--brand)">${cur(purchase.total - purchase.paid)}</div></div>
      </div>
      ${purchase.notes ? `<p class="muted" style="margin-top:14px">${h(purchase.notes)}</p>` : ""}
      </div></div>

    <div class="card"><div class="card-head"><h2>Items</h2></div>
      <div class="card-body flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Amount</th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td><span class="mono muted">${h(i.sku)}</span> ${h(i.product_name)}</td>
          <td class="num">${qty(i.qty)} ${h(i.unit)}</td>
          <td class="num">${money(i.price)}</td>
          <td class="num strong">${money(i.line_total)}</td></tr>`).join("")}
        </tbody></table></div>
        <div style="padding:16px"><div class="totals">
          <div><span>Subtotal</span><span>${money(purchase.subtotal)}</span></div>
          <div><span>Discount</span><span>- ${money(purchase.discount)}</span></div>
          <div><span>Tax</span><span>${money(purchase.tax)}</span></div>
          <div class="grand"><span>Total</span><span>${cur(purchase.total)}</span></div>
        </div></div></div></div>

    <div class="toolbar">
      <button class="btn" onclick="location.hash='#/purchases'">&larr; Back to purchases</button>
      <span style="flex:1"></span>
      <button class="btn btn-danger" id="del-pur">Delete purchase</button>
    </div>`;

  $("#del-pur").addEventListener("click", () => confirmDialog(
    `Delete purchase ${purchase.purchase_no}? Stock it brought in will be reversed.`,
    async () => {
      await api("/purchases/" + purchaseId, { method: "DELETE" });
      toast("Purchase deleted.", "success");
      state.products = [];
      go("purchases");
    }, "Delete purchase"));
}

// ---------------------------------------------------------------- products

async function viewProducts() {
  await loadMasters(true);
  pageAction("+ New Product", () => productModal(null));
  pageAction("⤓ Excel", () => { window.location = "/api/products/export"; }, "btn");

  const categories = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  let search = "", category = "";

  function refresh() {
    const term = search.toLowerCase();
    const list = state.products.filter((p) =>
      (!category || p.category === category)
      && (!term || (p.name + " " + p.sku + " " + p.category).toLowerCase().includes(term)));
    $("#products-body").innerHTML = list.length ? list.map((p) => `
      <tr>
        <td class="mono strong">${h(p.sku)}</td>
        <td>${h(p.name)}${p.pack_size ? `<div class="muted">${h(p.pack_size)}</div>` : ""}</td>
        <td>${h(p.category) || `<span class="muted">-</span>`}</td>
        <td class="num">${money(p.purchase_price)}</td>
        <td class="num strong">${money(p.sale_price)}</td>
        <td class="num ${p.stock <= p.reorder_level ? "strong" : ""}"
            ${p.stock <= p.reorder_level ? 'style="color:var(--brand)"' : ""}>${qty(p.stock)} ${h(p.unit)}</td>
        <td>${p.active ? statusBadge("In Stock").replace("In Stock", "Active") : `<span class="badge grey">Inactive</span>`}</td>
        <td class="row-actions">
          <button class="btn btn-sm" data-edit="${p.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button></td>
      </tr>`).join("")
      : `<tr><td colspan="8">${emptyState("◧", "No products match", "Try a different search or category.")}</td></tr>`;

    document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click",
      () => productModal(state.products.find((p) => String(p.id) === b.dataset.edit))));
    document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const product = state.products.find((p) => String(p.id) === b.dataset.del);
      confirmDialog(`Delete "${product.name}"?`, async () => {
        closeModal();
        deleteWithCascade("/products/" + product.id, "Item", () => {
          state.products = []; viewProducts();
        });
      }, "Delete item");
    }));
  }

  el("content").innerHTML = `
    <div class="toolbar">
      <input class="search" id="f-q" placeholder="Search by name, code or category...">
      <select id="f-cat"><option value="">All categories</option>
        ${categories.map((c) => `<option>${h(c)}</option>`).join("")}</select>
      <span class="muted">${state.products.length} items</span>
    </div>
    ${tableCard(`<th>Code</th><th>Item description</th><th>Category</th><th class="num">Cost</th>
      <th class="num">Sale price</th><th class="num">On hand</th><th>Status</th><th></th>`, "")}`;
  $("table.data tbody").id = "products-body";

  $("#f-q").addEventListener("input", (e) => { search = e.target.value; refresh(); });
  $("#f-cat").addEventListener("change", (e) => { category = e.target.value; refresh(); });
  refresh();
}

function productModal(product) {
  const p = product || { unit: "pcs", active: 1 };
  const units = ["pcs", "pack", "kg", "gram", "ltr", "ml", "bottle", "jar", "bucket", "bag", "carton", "dozen"];
  modal({
    title: product ? "Edit product" : "New product",
    wide: true,
    body: `
      <div class="field-row">
        <label class="field">Item code (SKU)
          <input name="sku" value="${h(p.sku || "")}" placeholder="Auto-generated if left blank"></label>
        <label class="field">Item description *
          <input name="name" value="${h(p.name || "")}" required></label>
      </div>
      <div class="field-row">
        <label class="field">Category
          <input name="category" value="${h(p.category || "")}" list="cat-list" placeholder="e.g. Masala & Spices">
          <datalist id="cat-list">${[...new Set(state.products.map((x) => x.category).filter(Boolean))]
            .map((c) => `<option value="${h(c)}">`).join("")}</datalist></label>
        <label class="field">Unit
          <select name="unit">${units.map((u) => `<option ${u === p.unit ? "selected" : ""}>${u}</option>`).join("")}</select></label>
        <label class="field">Pack size
          <input name="pack_size" value="${h(p.pack_size || "")}" placeholder="e.g. 750 ml, 1 kg, Sachet"></label>
      </div>
      <div class="field-row">
        <label class="field">Cost price
          <input type="number" step="0.01" min="0" name="purchase_price" value="${p.purchase_price || 0}"></label>
        <label class="field">Sale price
          <input type="number" step="0.01" min="0" name="sale_price" value="${p.sale_price || 0}"></label>
        <label class="field">Reorder level
          <input type="number" step="0.01" min="0" name="reorder_level" value="${p.reorder_level || 0}"></label>
        ${product ? "" : `<label class="field">Opening stock
          <input type="number" step="0.01" min="0" name="stock" value="0"></label>`}
      </div>
      <div class="field-row">
        <label class="field">Preferred supplier
          <select name="supplier_id"><option value="">- none -</option>
            ${options(state.suppliers, p.supplier_id)}</select></label>
        <div style="display:flex;align-items:flex-end">
          <label class="checkbox"><input type="checkbox" name="active" ${p.active ? "checked" : ""}> Active</label>
        </div>
      </div>
      <label class="field">Notes<textarea name="notes">${h(p.notes || "")}</textarea></label>
      ${product ? `<p class="muted" style="margin:12px 0 0;font-size:12.5px">
        On-hand stock is changed through purchases, deliveries and inventory adjustments -
        not by editing this form.</p>` : ""}`,
    submitLabel: product ? "Save changes" : "Create product",
    onSubmit: async (form) => {
      const values = formValues(form);
      if (product) await api("/products/" + product.id, { method: "PUT", body: values });
      else await api("/products", { method: "POST", body: values });
      toast(product ? "Product updated." : "Product created.", "success");
      state.products = [];
      viewProducts();
    },
  });
}

// --------------------------------------------------------------- inventory

async function viewInventory(rest) {
  if (rest[0] === "moves") return viewStockMoves();
  const stock = await api("/stock");
  await loadMasters();
  setBadge("inventory", stock.filter((s) => s.stock <= s.reorder_level).length);

  pageAction("Adjust Stock", () => adjustModal());
  pageAction("Movement History", () => go("inventory/moves"), "btn");

  const costValue = stock.reduce((s, i) => s + Number(i.stock_value), 0);
  const retailValue = stock.reduce((s, i) => s + i.stock * i.sale_price, 0);
  let filter = "";

  function refresh() {
    const list = filter === "low" ? stock.filter((s) => s.stock > 0 && s.stock <= s.reorder_level)
      : filter === "out" ? stock.filter((s) => s.stock <= 0)
      : stock;
    $("#stock-body").innerHTML = list.length ? list.map((s) => `
      <tr>
        <td class="mono strong">${h(s.sku)}</td>
        <td>${h(s.name)}<div class="muted">${h(s.category)}</div></td>
        <td class="num strong">${qty(s.stock)} ${h(s.unit)}</td>
        <td class="num muted">${qty(s.reorder_level)}</td>
        <td class="num">${money(s.purchase_price)}</td>
        <td class="num strong">${money(s.stock_value)}</td>
        <td>${statusBadge(s.stock_state)}</td>
        <td class="row-actions">
          <button class="btn btn-sm" data-adjust="${s.id}">Adjust</button>
          <a class="btn btn-sm" href="#/inventory/moves?product=${s.id}">History</a></td>
      </tr>`).join("")
      : `<tr><td colspan="8">${emptyState("▩", "Nothing here", "No items in this view.")}</td></tr>`;

    document.querySelectorAll("[data-adjust]").forEach((b) =>
      b.addEventListener("click", () => adjustModal(b.dataset.adjust)));
  }

  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat blue"><div class="label">Stock value (at cost)</div>
        <div class="value">${cur(costValue)}</div><div class="sub">${stock.length} active items</div></div>
      <div class="stat green"><div class="label">Value at sale price</div>
        <div class="value">${cur(retailValue)}</div>
        <div class="sub">Potential margin ${cur(retailValue - costValue)}</div></div>
      <div class="stat amber"><div class="label">Low stock</div>
        <div class="value">${stock.filter((s) => s.stock > 0 && s.stock <= s.reorder_level).length}</div>
        <div class="sub">At or below reorder level</div></div>
      <div class="stat"><div class="label">Out of stock</div>
        <div class="value">${stock.filter((s) => s.stock <= 0).length}</div>
        <div class="sub">Nothing on hand</div></div>
    </div>
    <div class="toolbar">
      <select id="f-view"><option value="">All items</option>
        <option value="low">Low stock only</option><option value="out">Out of stock only</option></select>
    </div>
    ${tableCard(`<th>Code</th><th>Item</th><th class="num">On hand</th><th class="num">Reorder at</th>
      <th class="num">Cost</th><th class="num">Value</th><th>Status</th><th></th>`, "")}`;
  $("table.data tbody").id = "stock-body";
  $("#f-view").addEventListener("change", (e) => { filter = e.target.value; refresh(); });
  refresh();
}

function adjustModal(productId) {
  modal({
    title: "Stock adjustment",
    body: `
      <label class="field">Item *
        <select name="product_id" required><option value="">Select an item...</option>
          ${options(state.products, productId, (p) => `${p.sku} - ${p.name} (on hand: ${qty(p.stock)})`)}</select></label>
      <div class="field-row" style="margin-top:14px">
        <label class="field">Quantity change *
          <input type="number" step="0.01" name="qty" required placeholder="e.g. 25 to add, -5 to remove"></label>
        <label class="field">Reason
          <input name="note" placeholder="Damaged, count correction, sample..."></label>
      </div>
      <p class="muted" style="margin:12px 0 0;font-size:12.5px">
        Use a positive number to add stock and a negative number to remove it.
        Every adjustment is recorded in the movement history.</p>`,
    submitLabel: "Apply adjustment",
    onSubmit: async (form) => {
      await api("/stock/adjust", { method: "POST", body: formValues(form) });
      toast("Stock adjusted.", "success");
      state.products = [];
      viewInventory([]);
    },
  });
}

async function viewStockMoves() {
  const productId = new URLSearchParams(location.hash.split("?")[1] || "").get("product");
  const moves = await api("/stock/moves" + (productId ? "?product_id=" + productId : ""));
  el("page-title").textContent = "Stock Movement History";
  pageAction("Back to Inventory", () => go("inventory"), "btn");

  el("content").innerHTML = tableCard(
    `<th>Date</th><th>Item</th><th>Type</th><th class="num">Change</th>
     <th class="num">Balance</th><th>Reference</th><th>Note</th>`,
    moves.length ? moves.map((m) => `<tr>
      <td>${new Date(m.move_date).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
      <td><span class="mono muted">${h(m.sku)}</span> ${h(m.product_name)}</td>
      <td>${statusBadge(m.kind)}</td>
      <td class="num strong" style="color:${m.qty >= 0 ? "var(--green)" : "var(--brand)"}">
        ${m.qty >= 0 ? "+" : ""}${qty(m.qty)}</td>
      <td class="num">${qty(m.balance)} ${h(m.unit)}</td>
      <td class="mono muted">${h(m.reference)}</td>
      <td class="muted">${h(m.note)}</td></tr>`).join("") : null,
    emptyState("▩", "No stock movements yet", "Movements appear as you receive purchases and deliver orders."));
}

// -------------------------------------------------------- customers/suppliers

function partyView(kind) {
  const isCustomer = kind === "customers";
  const label = isCustomer ? "Customer" : "Supplier";

  return async function () {
    await loadMasters(true);
    const list = isCustomer ? state.customers : state.suppliers;
    pageAction("+ New " + label, () => partyModal(kind, null));

    let search = "";
    function refresh() {
      const term = search.toLowerCase();
      const filtered = list.filter((p) =>
        !term || (p.name + " " + p.contact + " " + p.phone + " " + p.city).toLowerCase().includes(term));
      $("#party-body").innerHTML = filtered.length ? filtered.map((p) => `
        <tr>
          <td class="strong">${h(p.name)}${p.tax_id ? `<div class="muted mono">NTN ${h(p.tax_id)}</div>` : ""}</td>
          <td>${h(p.contact) || `<span class="muted">-</span>`}</td>
          <td>${h(p.phone) || `<span class="muted">-</span>`}<div class="muted">${h(p.email)}</div></td>
          <td>${h(p.city) || `<span class="muted">-</span>`}<div class="muted">${h(p.address)}</div></td>
          <td>${p.active ? `<span class="badge green">Active</span>` : `<span class="badge grey">Inactive</span>`}</td>
          <td class="row-actions">
            ${isCustomer ? `<button class="btn btn-sm" data-ledger="${p.id}">Ledger</button>` : ""}
            <button class="btn btn-sm" data-edit="${p.id}">Edit</button>
            <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button></td>
        </tr>`).join("")
        : `<tr><td colspan="6">${emptyState(isCustomer ? "◍" : "◉", `No ${kind} yet`,
            `Add your first ${label.toLowerCase()} to start recording business.`,
            `<button class="btn btn-primary" id="empty-add">+ New ${label}</button>`)}</td></tr>`;

      const emptyAdd = $("#empty-add");
      if (emptyAdd) emptyAdd.addEventListener("click", () => partyModal(kind, null));
      document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click",
        () => partyModal(kind, list.find((p) => String(p.id) === b.dataset.edit))));
      document.querySelectorAll("[data-ledger]").forEach((b) => b.addEventListener("click",
        () => customerLedger(b.dataset.ledger)));
      document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
        const party = list.find((p) => String(p.id) === b.dataset.del);
        confirmDialog(`Delete "${party.name}"?`, async () => {
          closeModal();
          deleteWithCascade(`/${kind}/${party.id}`, label, () => partyView(kind)());
        }, "Delete " + label.toLowerCase());
      }));
    }

    el("content").innerHTML = `
      <div class="toolbar">
        <input class="search" id="f-q" placeholder="Search name, contact, phone or city...">
        <span class="muted">${list.length} ${kind}</span>
      </div>
      ${tableCard(`<th>${label}</th><th>Contact person</th><th>Phone / email</th>
        <th>City / address</th><th>Status</th><th></th>`, "")}`;
    $("table.data tbody").id = "party-body";
    $("#f-q").addEventListener("input", (e) => { search = e.target.value; refresh(); });
    refresh();
  };
}

// Declared as functions, not consts: ROUTES is built above this point and would
// hit the temporal dead zone on a const binding.
function viewCustomers(rest) { return partyView("customers")(rest); }
function viewSuppliers(rest) { return partyView("suppliers")(rest); }

function partyModal(kind, party) {
  const isCustomer = kind === "customers";
  const label = isCustomer ? "Customer" : "Supplier";
  const p = party || { active: 1 };
  modal({
    title: party ? `Edit ${label.toLowerCase()}` : `New ${label.toLowerCase()}`,
    wide: true,
    body: `
      <div class="field-row">
        <label class="field">${label} name *<input name="name" value="${h(p.name || "")}" required></label>
        <label class="field">Contact person<input name="contact" value="${h(p.contact || "")}"></label>
      </div>
      <div class="field-row">
        <label class="field">Phone<input name="phone" value="${h(p.phone || "")}" placeholder="0300-1234567"></label>
        <label class="field">Email<input type="email" name="email" value="${h(p.email || "")}"></label>
        <label class="field">NTN / Tax ID<input name="tax_id" value="${h(p.tax_id || "")}"></label>
      </div>
      <div class="field-row">
        <label class="field">Address<input name="address" value="${h(p.address || "")}"></label>
        <label class="field">City<input name="city" value="${h(p.city || "")}"></label>
      </div>
      <label class="field">Notes<textarea name="notes">${h(p.notes || "")}</textarea></label>
      <div style="margin-top:12px">
        <label class="checkbox"><input type="checkbox" name="active" ${p.active ? "checked" : ""}> Active</label>
      </div>`,
    submitLabel: party ? "Save changes" : "Create " + label.toLowerCase(),
    onSubmit: async (form) => {
      const values = formValues(form);
      if (party) await api(`/${kind}/${party.id}`, { method: "PUT", body: values });
      else await api("/" + kind, { method: "POST", body: values });
      toast(label + (party ? " updated." : " created."), "success");
      partyView(kind)();
    },
  });
}

async function customerLedger(customerId) {
  const data = await api(`/customers/${customerId}/ledger`);
  const due = data.invoices.reduce((s, i) => s + (i.total - i.paid), 0);
  modal({
    title: data.customer.name + " - account",
    wide: true,
    body: `
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat"><div class="label">Orders</div><div class="value">${data.orders.length}</div></div>
        <div class="stat green"><div class="label">Invoiced</div>
          <div class="value">${cur(data.invoices.reduce((s, i) => s + i.total, 0))}</div></div>
        <div class="stat amber"><div class="label">Outstanding</div><div class="value">${cur(due)}</div></div>
      </div>
      <h3 style="font-size:13px;margin:0 0 8px">Invoices</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Invoice</th><th>Date</th><th class="num">Total</th>
          <th class="num">Balance</th><th>Status</th></tr></thead>
        <tbody>${data.invoices.length ? data.invoices.map((i) => `<tr>
          <td class="mono">${h(i.invoice_no)}</td><td>${fmtDate(i.invoice_date)}</td>
          <td class="num">${money(i.total)}</td><td class="num">${money(i.total - i.paid)}</td>
          <td>${statusBadge(i.status)}</td></tr>`).join("")
          : `<tr><td colspan="5" class="empty">No invoices yet.</td></tr>`}
        </tbody></table></div>
      <h3 style="font-size:13px;margin:18px 0 8px">Orders</h3>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Order</th><th>Date</th><th>Status</th><th>Delivery</th><th class="num">Total</th></tr></thead>
        <tbody>${data.orders.length ? data.orders.map((o) => `<tr>
          <td class="mono">${h(o.order_no)}</td><td>${fmtDate(o.order_date)}</td>
          <td>${statusBadge(o.status)}</td><td>${statusBadge(o.delivery_status)}</td>
          <td class="num">${money(o.total)}</td></tr>`).join("")
          : `<tr><td colspan="5" class="empty">No orders yet.</td></tr>`}
        </tbody></table></div>`,
  });
}

// -------------------------------------------------------------- accounting

const ACCOUNT_TYPES = ["Asset", "Liability", "Equity", "Income", "Expense"];

async function viewAccounts(rest) {
  if (rest[0]) return viewLedger(rest[0]);
  const accounts = await api("/accounts");
  pageAction("+ New Account", () => accountModal());

  const groups = ACCOUNT_TYPES.map((kind) => {
    const list = accounts.filter((a) => a.type === kind);
    if (!list.length) return "";
    return `<tr><td colspan="5" style="background:var(--surface-2);font-weight:700;
              text-transform:uppercase;font-size:11px;letter-spacing:.06em;color:var(--ink-3)">
              ${h(kind)}</td></tr>` + list.map((a) => {
      const net = kind === "Asset" || kind === "Expense"
        ? a.debits - a.credits : a.credits - a.debits;
      return `<tr>
        <td class="mono strong"><a href="#/accounts/${a.id}">${h(a.code)}</a></td>
        <td>${h(a.name)}${a.system ? ` <span class="badge grey">system</span>` : ""}</td>
        <td class="muted">${h(a.subtype) || "-"}</td>
        <td class="num strong">${money(net)}</td>
        <td class="row-actions">
          <a class="btn btn-sm" href="#/accounts/${a.id}">Ledger</a>
          ${a.system ? "" : `<button class="btn btn-sm btn-danger" data-del="${a.id}">Delete</button>`}
        </td></tr>`;
    }).join("");
  }).join("");

  el("content").innerHTML = `
    <div class="card"><div class="card-body">
      <p class="muted" style="margin:0">Every invoice, purchase, payment and expense posts
        to these accounts automatically. Click any account to see its ledger.</p>
    </div></div>
    ${tableCard(`<th>Code</th><th>Account</th><th>Group</th><th class="num">Balance</th><th></th>`,
      groups)}`;

  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const a = accounts.find((x) => String(x.id) === b.dataset.del);
    confirmDialog(`Delete account ${a.code} ${a.name}?`, async () => {
      closeModal();
      deleteWithCascade("/accounts/" + a.id, "Account", viewAccounts);
    }, "Delete account");
  }));
}

function accountModal() {
  modal({
    title: "New account",
    body: `
      <div class="field-row">
        <label class="field">Code *<input name="code" placeholder="6500" required></label>
        <label class="field">Name *<input name="name" placeholder="Marketing" required></label>
      </div>
      <div class="field-row">
        <label class="field">Type *
          <select name="type">${ACCOUNT_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></label>
        <label class="field">Group<input name="subtype" placeholder="Operating"></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="is_cash"> This is a cash or bank account</label>`,
    submitLabel: "Create account",
    onSubmit: async (form) => {
      await api("/accounts", { method: "POST", body: formValues(form) });
      toast("Account created.", "success");
      viewAccounts([]);
    },
  });
}

async function viewLedger(accountId) {
  const data = await api("/reports/ledger/" + accountId);
  el("page-title").textContent = `${data.account.code} ${data.account.name}`;
  if (data.account.is_cash) pageAction("Reconcile", () => reconcileModal(data.account));
  pageAction("Back to Chart", () => go("accounts"), "btn");
  el("content").innerHTML = `
    <div class="stat-grid">
      <div class="stat blue"><div class="label">Closing balance</div>
        <div class="value">${cur(data.closing)}</div>
        <div class="sub">${h(data.account.type)}</div></div>
      <div class="stat"><div class="label">Postings</div>
        <div class="value">${data.lines.length}</div></div>
    </div>
    ${tableCard(`<th>Date</th><th>Entry</th><th>Detail</th>
       <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>`,
      data.lines.length ? data.lines.map((l) => `<tr>
        <td>${fmtDate(l.entry_date)}</td>
        <td class="mono">${h(l.entry_no)}<div class="muted">${h(l.source)}</div></td>
        <td>${h(l.line_memo || l.memo)}</td>
        <td class="num">${l.debit ? money(l.debit) : ""}</td>
        <td class="num">${l.credit ? money(l.credit) : ""}</td>
        <td class="num strong">${money(l.balance)}</td></tr>`).join("") : null,
      emptyState("▤", "Nothing posted here yet", "Postings appear as you trade."))}`;
}

async function viewJournal() {
  await loadMasters();
  const [entries, accounts] = await Promise.all([api("/journal"), api("/accounts")]);
  pageAction("+ Journal Entry", () => journalModal(accounts));
  pageAction("Record Expense", () => expenseModal(accounts), "btn");

  el("content").innerHTML = tableCard(
    `<th>Date</th><th>Entry</th><th>Description</th><th>Accounts</th>
     <th class="num">Amount</th><th></th>`,
    entries.length ? entries.map((e) => {
      const total = e.lines.reduce((s, l) => s + l.debit, 0);
      return `<tr>
        <td>${fmtDate(e.entry_date)}</td>
        <td class="mono strong">${h(e.entry_no)}<div class="muted">${h(e.source)}</div></td>
        <td>${h(e.memo)}</td>
        <td class="muted" style="font-size:12px">${e.lines.map((l) =>
          `${h(l.code)} ${l.debit ? "Dr " + money(l.debit) : "Cr " + money(l.credit)}`
          ).join("<br>")}</td>
        <td class="num strong">${money(total)}</td>
        <td class="row-actions">${e.source === "Manual"
          ? `<button class="btn btn-sm btn-danger" data-del="${e.id}">Delete</button>` : ""}</td>
      </tr>`;
    }).join("") : null,
    emptyState("✎", "No entries yet", "Entries appear as you invoice, buy and pay."));

  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    confirmDialog("Delete this journal entry?", async () => {
      await api("/journal/" + b.dataset.del, { method: "DELETE" });
      toast("Entry deleted.", "success");
      viewJournal();
    }, "Delete entry");
  }));
}

function accountOptions(accounts, selected) {
  return accounts.map((a) =>
    `<option value="${a.id}" ${String(a.id) === String(selected) ? "selected" : ""}>
       ${h(a.code)} - ${h(a.name)}</option>`).join("");
}

function journalModal(accounts) {
  let lines = [{}, {}];
  const render = () => `
    <label class="field">Date<input type="date" name="entry_date" value="${today()}"></label>
    <label class="field" style="margin-top:12px">Description
      <input name="memo" placeholder="What this entry is for"></label>
    <table class="items-table" style="margin-top:14px"><thead><tr>
      <th style="width:52%">Account</th><th>Debit</th><th>Credit</th></tr></thead>
      <tbody>${lines.map((_, i) => `<tr>
        <td><select data-i="${i}" data-f="account_id">
          <option value="">Select...</option>${accountOptions(accounts)}</select></td>
        <td><input class="qty" type="number" step="0.01" min="0" data-i="${i}" data-f="debit"></td>
        <td><input class="qty" type="number" step="0.01" min="0" data-i="${i}" data-f="credit"></td>
      </tr>`).join("")}</tbody></table>
    <button type="button" class="btn btn-sm" id="add-jline">+ Add line</button>
    <div class="muted" id="jbalance" style="margin-top:10px;font-size:12.5px"></div>`;

  const form = modal({
    title: "Journal entry", wide: true, body: render(), submitLabel: "Post entry",
    onSubmit: async (f) => {
      const values = formValues(f);
      await api("/journal", { method: "POST", body: {
        entry_date: values.entry_date, memo: values.memo, lines }});
      toast("Entry posted.", "success");
      viewJournal();
    },
  });

  const wire = () => {
    form.querySelectorAll("[data-f]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const { i, f } = e.target.dataset;
        lines[i][f] = f === "account_id" ? e.target.value : Number(e.target.value || 0);
        const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
        const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
        $("#jbalance", form).innerHTML = Math.abs(dr - cr) < 0.005 && dr > 0
          ? `<span style="color:var(--green);font-weight:700">Balanced &mdash; ${money(dr)}</span>`
          : `Debits ${money(dr)} &middot; Credits ${money(cr)} &mdash;
             <span style="color:var(--brand)">difference ${money(Math.abs(dr - cr))}</span>`;
      });
    });
    $("#add-jline", form).addEventListener("click", () => {
      lines.push({});
      $(".modal-body", form).innerHTML = `<div class="form-error hidden" data-error></div>` + render();
      wire();
    });
  };
  wire();
}

function expenseModal(accounts) {
  const expenses = accounts.filter((a) => a.type === "Expense");
  const cash = accounts.filter((a) => a.is_cash);
  modal({
    title: "Record an expense",
    body: `
      <div class="field-row">
        <label class="field">Date<input type="date" name="entry_date" value="${today()}"></label>
        <label class="field">Amount *
          <input type="number" step="0.01" min="0" name="amount" required></label>
      </div>
      <div class="field-row">
        <label class="field">Expense type
          <select name="expense_account">${expenses.map((a) =>
            `<option value="${h(a.code)}">${h(a.code)} - ${h(a.name)}</option>`).join("")}</select></label>
        <label class="field">Paid from
          <select name="paid_from">${cash.map((a) =>
            `<option value="${h(a.code)}">${h(a.name)}</option>`).join("")}</select></label>
      </div>
      <label class="field">Description<input name="memo" placeholder="Shop rent for August"></label>`,
    submitLabel: "Record expense",
    onSubmit: async (form) => {
      await api("/expenses", { method: "POST", body: formValues(form) });
      toast("Expense recorded.", "success");
      viewJournal();
    },
  });
}

async function viewAging() {
  let kind = "receivable";
  async function refresh() {
    const r = await api(`/reports/aging?kind=${kind}`);
    const b = r.buckets;
    const label = kind === "payable" ? "we owe" : "owed to us";
    $("#aging-body").innerHTML = `
      <div class="stat-grid">
        <div class="stat ${kind === "payable" ? "" : "green"}">
          <div class="label">Total ${h(label)}</div><div class="value">${cur(r.total)}</div></div>
        <div class="stat blue"><div class="label">Not yet due</div>
          <div class="value">${cur(b.current)}</div></div>
        <div class="stat amber"><div class="label">1 - 30 days</div>
          <div class="value">${cur(b.d30)}</div></div>
        <div class="stat amber"><div class="label">31 - 90 days</div>
          <div class="value">${cur(b.d60 + b.d90)}</div></div>
        <div class="stat"><div class="label">Over 90 days</div>
          <div class="value" style="color:var(--brand)">${cur(b.older)}</div></div>
      </div>
      ${reportTable(kind === "payable" ? "By supplier" : "By customer",
        `<th>${kind === "payable" ? "Supplier" : "Customer"}</th>
         <th class="num">Not due</th><th class="num">1-30</th><th class="num">31-60</th>
         <th class="num">61-90</th><th class="num">90+</th><th class="num">Total</th>`,
        r.by_party.map((x) => `<tr><td class="strong">${h(x.party)}</td>
          <td class="num">${money(x.current)}</td><td class="num">${money(x.d30)}</td>
          <td class="num">${money(x.d60)}</td><td class="num">${money(x.d90)}</td>
          <td class="num" style="color:var(--brand)">${money(x.older)}</td>
          <td class="num strong">${money(x.total)}</td></tr>`))}
      ${reportTable("Document by document",
        `<th>Reference</th><th>Party</th><th>Date</th><th class="num">Days</th>
         <th class="num">Outstanding</th>`,
        r.documents.map((d) => `<tr><td class="mono">${h(d.ref)}</td>
          <td>${h(d.party)}</td><td>${fmtDate(d.doc_date)}</td>
          <td class="num ${d.days > 90 ? "strong" : ""}">${d.days}</td>
          <td class="num strong">${money(d.outstanding)}</td></tr>`))}`;
  }
  el("content").innerHTML = `
    <div class="toolbar">
      <select id="a-kind">
        <option value="receivable">Money owed to us (customers)</option>
        <option value="payable">Money we owe (suppliers)</option>
      </select>
    </div><div id="aging-body"></div>`;
  $("#a-kind").addEventListener("change", (e) => { kind = e.target.value; refresh(); });
  refresh();
}

async function viewAssets() {
  const assets = await api("/assets");
  pageAction("+ New Asset", () => assetModal());
  pageAction("Post Depreciation", () => {
    modal({
      title: "Post depreciation",
      body: `<p style="margin-top:0">Posts one month of straight-line depreciation for
        every asset that still has value to write off.</p>
        <label class="field">Date<input type="date" name="to" value="${today()}"></label>`,
      submitLabel: "Post depreciation",
      onSubmit: async (form) => {
        const r = await api("/assets/depreciate", { method: "POST", body: formValues(form) });
        toast(r.total ? `Posted ${cur(r.total)} of depreciation.` : "Nothing left to depreciate.",
              "success");
        viewAssets();
      },
    });
  }, "btn");

  el("content").innerHTML = tableCard(
    `<th>Asset</th><th>Bought</th><th class="num">Cost</th><th class="num">Monthly</th>
     <th>Depreciated to</th><th></th>`,
    assets.length ? assets.map((a) => `<tr>
      <td class="strong">${h(a.name)}</td>
      <td>${fmtDate(a.purchase_date)}</td>
      <td class="num">${money(a.cost)}</td>
      <td class="num">${money((a.cost - a.salvage) / Math.max(a.life_months, 1))}
        <div class="muted">${a.life_months} months</div></td>
      <td>${a.depreciated_to ? fmtDate(a.depreciated_to) : `<span class="muted">not yet</span>`}</td>
      <td class="row-actions">
        <button class="btn btn-sm btn-danger" data-del="${a.id}">Delete</button></td>
    </tr>`).join("") : null,
    emptyState("▣", "No fixed assets", "Add vehicles, freezers or equipment to depreciate them.",
      `<button class="btn btn-primary" id="add-asset">+ New Asset</button>`));

  const add = $("#add-asset");
  if (add) add.addEventListener("click", () => assetModal());
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    confirmDialog("Delete this asset? Posted depreciation stays in the ledger.", async () => {
      await api("/assets/" + b.dataset.del, { method: "DELETE" });
      toast("Asset removed.", "success");
      viewAssets();
    }, "Delete asset");
  }));
}

function assetModal() {
  modal({
    title: "New fixed asset",
    body: `
      <label class="field">Name *<input name="name" placeholder="Delivery van" required></label>
      <div class="field-row" style="margin-top:12px">
        <label class="field">Bought on<input type="date" name="purchase_date" value="${today()}"></label>
        <label class="field">Cost *<input type="number" step="0.01" min="0" name="cost" required></label>
      </div>
      <div class="field-row">
        <label class="field">Value at end<input type="number" step="0.01" min="0" name="salvage" value="0"></label>
        <label class="field">Useful life (months)<input type="number" min="1" name="life_months" value="60"></label>
      </div>
      <p class="muted" style="margin:0;font-size:12.5px">Cost less end value is spread evenly
        over the months, charged to Depreciation each time you post it.</p>`,
    submitLabel: "Add asset",
    onSubmit: async (form) => {
      await api("/assets", { method: "POST", body: formValues(form) });
      toast("Asset added.", "success");
      viewAssets();
    },
  });
}

async function reconcileModal(account) {
  const data = await api(`/reports/reconcile/${account.id}`);
  const body = `
    <div class="stat-grid" style="margin-bottom:12px">
      <div class="stat blue"><div class="label">Ledger balance</div>
        <div class="value">${cur(data.ledger_balance)}</div></div>
      <div class="stat green"><div class="label">Cleared</div>
        <div class="value" id="rec-cleared">${cur(data.cleared_balance)}</div></div>
      <div class="stat amber"><div class="label">Not yet cleared</div>
        <div class="value" id="rec-unc">${cur(data.uncleared)}</div></div>
    </div>
    <p class="muted" style="margin:0 0 10px;font-size:12.5px">Tick each line that appears on
      your bank or cash statement. When cleared matches the statement, you are reconciled.</p>
    <div class="table-wrap"><table class="data"><thead><tr>
      <th></th><th>Date</th><th>Entry</th><th>Detail</th>
      <th class="num">In</th><th class="num">Out</th></tr></thead>
      <tbody>${data.lines.map((l) => `<tr>
        <td><input type="checkbox" data-line="${l.id}" ${l.cleared ? "checked" : ""}
                   style="width:auto;margin:0"></td>
        <td>${fmtDate(l.entry_date)}</td>
        <td class="mono">${h(l.entry_no)}</td>
        <td>${h(l.entry_memo)}</td>
        <td class="num">${l.debit ? money(l.debit) : ""}</td>
        <td class="num">${l.credit ? money(l.credit) : ""}</td></tr>`).join("")}
      </tbody></table></div>`;
  const form = modal({ title: `Reconcile ${account.name}`, wide: true, body });
  form.querySelectorAll("[data-line]").forEach((box) => {
    box.addEventListener("change", async (e) => {
      await api(`/journal/lines/${e.target.dataset.line}/clear`,
                { method: "POST", body: { cleared: e.target.checked } });
      const fresh = await api(`/reports/reconcile/${account.id}`);
      $("#rec-cleared", form).textContent = cur(fresh.cleared_balance);
      $("#rec-unc", form).textContent = cur(fresh.uncleared);
    });
  });
}

async function viewFinancials() {
  let tab = "profit-loss";
  let from = monthStart();
  let to = today();

  async function refresh() {
    const box = $("#fin-body");
    box.innerHTML = `<div class="empty"><div class="big">⏳</div><p>Preparing...</p></div>`;
    try {
      if (tab === "profit-loss") {
        const r = await api(`/reports/profit-loss?from=${from}&to=${to}`);
        const row = (a) => `<tr><td class="mono muted">${h(a.code)}</td><td>${h(a.name)}</td>
          <td class="num">${money(a.amount)}</td></tr>`;
        box.innerHTML = `
          <div class="stat-grid">
            <div class="stat green"><div class="label">Gross profit</div>
              <div class="value">${cur(r.gross_profit)}</div>
              <div class="sub">Sales less cost of sales</div></div>
            <div class="stat ${r.net_profit >= 0 ? "green" : ""}">
              <div class="label">Net profit</div><div class="value">${cur(r.net_profit)}</div>
              <div class="sub">After all expenses</div></div>
          </div>
          ${reportTable("Income", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.income.map(row).concat([`<tr><td></td><td class="strong">Total income</td>
              <td class="num strong">${money(r.total_income)}</td></tr>`]))}
          ${reportTable("Cost of sales", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.expense.filter((a) => a.subtype === "Cost of Sales").map(row)
              .concat([`<tr><td></td><td class="strong">Gross profit</td>
                <td class="num strong">${money(r.gross_profit)}</td></tr>`]))}
          ${reportTable("Expenses", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.expense.filter((a) => a.subtype !== "Cost of Sales").map(row)
              .concat([`<tr><td></td><td class="strong">Net profit</td>
                <td class="num strong">${money(r.net_profit)}</td></tr>`]))}`;
      } else if (tab === "balance-sheet") {
        const r = await api(`/reports/balance-sheet?to=${to}`);
        const row = (a) => `<tr><td class="mono muted">${h(a.code)}</td><td>${h(a.name)}</td>
          <td class="num">${money(a.amount)}</td></tr>`;
        box.innerHTML = `
          <div class="card"><div class="card-body">
            <div class="${r.balances ? "" : "form-error"}" style="margin:0">
              ${r.balances
                ? `<span class="badge green">In balance</span>
                   <span class="muted"> Assets ${cur(r.total_assets)} =
                   Liabilities ${cur(r.total_liabilities)} + Equity ${cur(r.total_equity)}</span>`
                : "The books do not balance. This should not happen - please report it."}
            </div></div></div>
          ${reportTable("Assets", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.assets.map(row).concat([`<tr><td></td><td class="strong">Total assets</td>
              <td class="num strong">${money(r.total_assets)}</td></tr>`]))}
          ${reportTable("Liabilities", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.liabilities.map(row).concat([`<tr><td></td><td class="strong">Total liabilities</td>
              <td class="num strong">${money(r.total_liabilities)}</td></tr>`]))}
          ${reportTable("Equity", `<th>Code</th><th>Account</th><th class="num">Amount</th>`,
            r.equity.map(row).concat([
              `<tr><td></td><td>Profit for the period</td>
                <td class="num">${money(r.retained_this_period)}</td></tr>`,
              `<tr><td></td><td class="strong">Total equity</td>
                <td class="num strong">${money(r.total_equity)}</td></tr>`]))}`;
      } else {
        const r = await api(`/reports/trial-balance?to=${to}`);
        const ok = Math.abs(r.total_debit - r.total_credit) < 0.01;
        box.innerHTML = `
          <div class="card"><div class="card-body" style="margin:0">
            ${ok ? `<span class="badge green">Balanced</span>
                    <span class="muted"> Debits and credits both ${cur(r.total_debit)}</span>`
                 : `<div class="form-error">Out of balance.</div>`}
          </div></div>
          ${reportTable("Trial balance", `<th>Code</th><th>Account</th>
            <th class="num">Debit</th><th class="num">Credit</th>`,
            r.accounts.map((a) => `<tr><td class="mono muted">${h(a.code)}</td>
              <td>${h(a.name)}</td>
              <td class="num">${a.debit_balance ? money(a.debit_balance) : ""}</td>
              <td class="num">${a.credit_balance ? money(a.credit_balance) : ""}</td></tr>`)
              .concat([`<tr><td></td><td class="strong">Totals</td>
                <td class="num strong">${money(r.total_debit)}</td>
                <td class="num strong">${money(r.total_credit)}</td></tr>`]))}`;
      }
    } catch (err) {
      box.innerHTML = err.offline ? offlinePanel()
        : `<div class="card"><div class="card-body"><div class="form-error">${h(err.message)}</div></div></div>`;
    }
  }

  if (state.user.role === "admin") {
    pageAction("Close the Year", async () => {
      const done = await api("/accounting/closings");
      const last = done.length ? `Last closed to ${fmtDate(done[0].closed_to)}.` : "Never closed.";
      modal({
        title: "Close the year",
        body: `<p style="margin-top:0">This sweeps income and expenses into Retained
            Earnings, so the next year starts from zero and the profit stays on the
            balance sheet. ${h(last)}</p>
          <label class="field">Close up to<input type="date" name="to" value="${today()}"></label>
          <label class="field" style="margin-top:12px">Type <strong>CLOSE</strong> to confirm
            <input name="confirm" autocomplete="off" placeholder="CLOSE"></label>`,
        submitLabel: "Close the year",
        onSubmit: async (form) => {
          const r = await api("/accounting/close", { method: "POST", body: formValues(form) });
          toast(`Closed. ${cur(r.net_profit)} carried to retained earnings.`, "success");
          refresh();
        },
      });
    }, "btn");
  }
  pageAction("Print", () => {
    el("print-root").innerHTML = `<div class="doc">
      <h2 style="color:var(--brand)">${h(state.company.name)}</h2>
      <p class="muted">${tab.replace("-", " ")} &middot; to ${fmtDate(to)}</p>
      ${$("#fin-body").innerHTML}</div>`;
    window.print();
  }, "btn");

  el("content").innerHTML = `
    <div class="toolbar">
      <select id="f-tab">
        <option value="profit-loss">Profit &amp; Loss</option>
        <option value="balance-sheet">Balance Sheet</option>
        <option value="trial-balance">Trial Balance</option>
      </select>
      <label class="field" id="f-from">From <input type="date" id="d-from" value="${from}"></label>
      <label class="field">As at <input type="date" id="d-to" value="${to}"></label>
      <button class="btn btn-primary btn-sm" id="f-run">Show</button>
    </div>
    <div id="fin-body"></div>`;

  $("#f-tab").addEventListener("change", (e) => {
    tab = e.target.value;
    $("#f-from").classList.toggle("hidden", tab !== "profit-loss");
    refresh();
  });
  $("#f-run").addEventListener("click", () => {
    from = $("#d-from").value; to = $("#d-to").value; refresh();
  });
  refresh();
}

// ----------------------------------------------------------------- reports

async function viewReports() {
  let tab = "sales";
  let from = monthStart();
  let to = today();

  async function refresh() {
    const box = $("#report-body");
    box.innerHTML = `<div class="empty"><div class="big">⏳</div><p>Building report...</p></div>`;
    try {
      await buildReport(box);
    } catch (err) {
      box.innerHTML = err.offline ? offlinePanel()
        : `<div class="card"><div class="card-body">
             <div class="form-error">${h(err.message)}</div></div></div>`;
    }
  }

  async function buildReport(box) {
    if (tab === "sales") {
      const r = await api(`/reports/sales?from=${from}&to=${to}`);
      box.innerHTML = `
        <div class="stat-grid">
          <div class="stat green"><div class="label">Total sales</div><div class="value">${cur(r.summary.total)}</div>
            <div class="sub">${r.summary.invoices} invoices</div></div>
          <div class="stat blue"><div class="label">Received</div><div class="value">${cur(r.summary.paid)}</div></div>
          <div class="stat amber"><div class="label">Outstanding</div><div class="value">${cur(r.summary.outstanding)}</div></div>
          <div class="stat"><div class="label">Discount given</div><div class="value">${cur(r.summary.discount)}</div>
            <div class="sub">Tax ${cur(r.summary.tax)}</div></div>
        </div>
        ${reportTable("Sales by customer", `<th>Customer</th><th class="num">Invoices</th>
          <th class="num">Amount</th><th class="num">Outstanding</th>`,
          r.by_customer.map((c) => `<tr><td class="strong">${h(c.name)}</td><td class="num">${c.n}</td>
            <td class="num strong">${money(c.amount)}</td><td class="num">${money(c.outstanding)}</td></tr>`))}
        ${reportTable("Sales by item", `<th>Code</th><th>Item</th><th class="num">Qty sold</th><th class="num">Amount</th>`,
          r.by_product.map((p) => `<tr><td class="mono">${h(p.sku)}</td><td>${h(p.name)}</td>
            <td class="num">${qty(p.qty)} ${h(p.unit)}</td><td class="num strong">${money(p.amount)}</td></tr>`))}
        ${reportTable("Day by day", `<th>Date</th><th class="num">Invoices</th><th class="num">Amount</th>`,
          r.by_day.map((d) => `<tr><td>${fmtDate(d.d)}</td><td class="num">${d.n}</td>
            <td class="num strong">${money(d.amount)}</td></tr>`))}`;
    } else if (tab === "purchases") {
      const r = await api(`/reports/purchases?from=${from}&to=${to}`);
      box.innerHTML = `
        <div class="stat-grid">
          <div class="stat blue"><div class="label">Total purchases</div><div class="value">${cur(r.summary.total)}</div>
            <div class="sub">${r.summary.purchases} purchases</div></div>
          <div class="stat green"><div class="label">Paid</div><div class="value">${cur(r.summary.paid)}</div></div>
          <div class="stat amber"><div class="label">Owed to suppliers</div><div class="value">${cur(r.summary.outstanding)}</div></div>
        </div>
        ${reportTable("Purchases by supplier", `<th>Supplier</th><th class="num">Bills</th>
          <th class="num">Amount</th><th class="num">Outstanding</th>`,
          r.by_supplier.map((s) => `<tr><td class="strong">${h(s.name)}</td><td class="num">${s.n}</td>
            <td class="num strong">${money(s.amount)}</td><td class="num">${money(s.outstanding)}</td></tr>`))}
        ${reportTable("Purchases by item", `<th>Code</th><th>Item</th><th class="num">Qty bought</th><th class="num">Amount</th>`,
          r.by_product.map((p) => `<tr><td class="mono">${h(p.sku)}</td><td>${h(p.name)}</td>
            <td class="num">${qty(p.qty)} ${h(p.unit)}</td><td class="num strong">${money(p.amount)}</td></tr>`))}`;
    } else {
      const r = await api("/reports/inventory");
      box.innerHTML = `
        <div class="stat-grid">
          <div class="stat blue"><div class="label">Stock value at cost</div><div class="value">${cur(r.summary.cost_value)}</div>
            <div class="sub">${r.summary.products} active items</div></div>
          <div class="stat green"><div class="label">Value at sale price</div><div class="value">${cur(r.summary.retail_value)}</div></div>
          <div class="stat amber"><div class="label">Low stock</div><div class="value">${r.summary.low_stock}</div></div>
          <div class="stat"><div class="label">Out of stock</div><div class="value">${r.summary.out_of_stock}</div></div>
        </div>
        ${reportTable("Stock by category", `<th>Category</th><th class="num">Items</th>
          <th class="num">Total qty</th><th class="num">Value at cost</th>`,
          r.by_category.map((c) => `<tr><td class="strong">${h(c.category)}</td><td class="num">${c.n}</td>
            <td class="num">${qty(c.qty)}</td><td class="num strong">${money(c.cost_value)}</td></tr>`))}
        ${reportTable("Full stock list", `<th>Code</th><th>Item</th><th class="num">On hand</th>
          <th class="num">Value</th><th>Status</th>`,
          r.items.map((i) => `<tr><td class="mono">${h(i.sku)}</td><td>${h(i.name)}</td>
            <td class="num">${qty(i.stock)} ${h(i.unit)}</td><td class="num">${money(i.stock_value)}</td>
            <td>${statusBadge(i.stock_state)}</td></tr>`))}`;
    }
  }

  pageAction("⤓ Download Excel", () => {
    const range = tab === "inventory" ? "" : `?from=${from}&to=${to}`;
    window.location = `/api/reports/${tab}/export${range}`;
    toast("Excel file downloading...", "success");
  });
  pageAction("Print report", () => {
    el("print-root").innerHTML = `<div class="doc"><h2 style="color:var(--brand)">${h(state.company.name)}</h2>
      <p class="muted">${tab.charAt(0).toUpperCase() + tab.slice(1)} report &middot; ${fmtDate(from)} to ${fmtDate(to)}</p>
      ${$("#report-body").innerHTML}</div>`;
    window.print();
  }, "btn");

  el("content").innerHTML = `
    <div class="toolbar">
      <select id="r-tab">
        <option value="sales">Sales report</option>
        <option value="purchases">Purchase report</option>
        <option value="inventory">Inventory report</option>
      </select>
      <label class="field" id="date-from">From <input type="date" id="r-from" value="${from}"></label>
      <label class="field" id="date-to">To <input type="date" id="r-to" value="${to}"></label>
      <button class="btn btn-primary btn-sm" id="r-run">Run</button>
    </div>
    <div id="report-body"></div>`;

  $("#r-tab").addEventListener("change", (e) => {
    tab = e.target.value;
    const showDates = tab !== "inventory";
    $("#date-from").classList.toggle("hidden", !showDates);
    $("#date-to").classList.toggle("hidden", !showDates);
    refresh();
  });
  $("#r-run").addEventListener("click", () => {
    from = $("#r-from").value; to = $("#r-to").value; refresh();
  });
  refresh();
}

function reportTable(title, headers, rowsHtml) {
  return `<div class="card"><div class="card-head"><h2>${h(title)}</h2></div>
    <div class="card-body flush"><div class="table-wrap"><table class="data">
      <thead><tr>${headers}</tr></thead>
      <tbody>${rowsHtml.length ? rowsHtml.join("") : `<tr><td colspan="9" class="empty">No data for this period.</td></tr>`}</tbody>
    </table></div></div></div>`;
}

// --------------------------------------------------------- company profile

async function viewCompany() {
  const company = await api("/company");
  state.company = company;
  const readOnly = state.user.role !== "admin";
  let logoData = company.logo || "";

  el("content").innerHTML = `
    <form id="company-form">
      <div class="card"><div class="card-head"><h2>Business identity</h2></div>
        <div class="card-body">
          <div class="form-error hidden" id="co-error"></div>
          <div class="logo-picker" style="margin-bottom:18px">
            <img class="logo-preview" id="logo-preview" src="${h(logoData)}" alt="Company logo">
            <div>
              <div class="strong" style="margin-bottom:4px">Company logo</div>
              <p class="muted" style="margin:0 0 8px;font-size:12.5px">
                PNG or JPG, square works best. It appears on every invoice and on the sign-in screen.</p>
              <input type="file" id="logo-file" accept="image/*" style="display:none">
              <button type="button" class="btn btn-sm" id="logo-btn" ${readOnly ? "disabled" : ""}>Upload logo</button>
              <button type="button" class="btn btn-sm btn-danger" id="logo-clear" ${readOnly ? "disabled" : ""}>Remove</button>
            </div>
          </div>
          <div class="field-row">
            <label class="field">Business name *<input name="name" value="${h(company.name)}" required></label>
            <label class="field">Tagline<input name="tagline" value="${h(company.tagline)}"></label>
          </div>
          <div class="field-row">
            <label class="field">Address<input name="address" value="${h(company.address)}"></label>
            <label class="field">City<input name="city" value="${h(company.city)}"></label>
          </div>
          <div class="field-row">
            <label class="field">Phone<input name="phone" value="${h(company.phone)}"></label>
            <label class="field">Email<input type="email" name="email" value="${h(company.email)}"></label>
            <label class="field">Website<input name="website" value="${h(company.website)}"></label>
          </div>
          <div class="field-row">
            <label class="field">NTN / Tax number<input name="tax_id" value="${h(company.tax_id)}"></label>
            <label class="field">Currency<input name="currency" value="${h(company.currency)}" maxlength="6"></label>
            <label class="field">Default tax rate (%)
              <input type="number" step="0.01" min="0" name="tax_rate" value="${company.tax_rate}"></label>
          </div>
          <label class="field">Invoice footer<input name="footer" value="${h(company.footer)}"></label>
        </div></div>
      ${readOnly ? `<p class="muted">Only an administrator can change the company profile.</p>` : `
      <div class="toolbar" style="justify-content:flex-end">
        <button type="submit" class="btn btn-primary">Save Company Profile</button>
      </div>`}
    </form>

    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Your account</h2></div>
        <div class="card-body">
          <p class="muted" style="margin-top:0">Signed in as <strong>${h(state.user.full_name || state.user.username)}</strong>
            (${h(state.user.role)}).</p>
          <button class="btn" id="pw-btn">Change my password</button>
        </div></div>

      <div class="card"><div class="card-head"><h2>Back up your data</h2></div>
        <div class="card-body">
          <p class="muted" style="margin-top:0">Every order, invoice, purchase and stock movement
            is stored in a single file on this computer. Download a copy and keep it somewhere
            safe &mdash; a USB stick or another drive. To restore, put the file back beside
            <span class="mono">app.py</span> as <span class="mono">usmantraders.db</span>.</p>
          ${state.user.role === "admin"
            ? `<button class="btn btn-primary" id="backup-btn">⤓ Download backup now</button>`
            : `<p class="muted">Only an administrator can download the backup.</p>`}
        </div></div>
    </div>

    ${state.user.role === "admin" ? `
    <div class="card" style="border-color:#f0c8c8">
      <div class="card-head" style="background:var(--brand-tint)">
        <h2 style="color:var(--brand)">Danger zone</h2></div>
      <div class="card-body">
        <p class="muted" style="margin-top:0">Bulk deletion. Take a backup first &mdash;
          there is no undo.</p>
        <div class="toolbar" style="margin:0">
          <button class="btn btn-danger" id="clear-tx">Delete all transactions</button>
          <button class="btn btn-danger" id="clear-all">Delete everything</button>
          <button class="btn btn-danger" id="clear-stock">Clear stock history</button>
        </div>
        <p class="muted" style="margin:12px 0 0;font-size:12.5px">
          <strong>All transactions</strong> removes orders, invoices, purchases, field entries
          and stock movements, keeping your items and contacts.
          <strong>Everything</strong> also removes items, customers and suppliers, then puts the
          64-item master back so the app stays usable.</p>
      </div></div>` : ""}`;

  $("#logo-btn").addEventListener("click", () => $("#logo-file").click());
  const danger = (id, scope, title, blurb) => {
    const button = $("#" + id);
    if (!button) return;
    button.addEventListener("click", () => modal({
      title,
      body: `<div class="form-error">${h(blurb)} This cannot be undone.</div>
        <label class="field">Type <strong>DELETE</strong> to confirm
          <input name="confirm" autocomplete="off" placeholder="DELETE"></label>`,
      submitLabel: title,
      onSubmit: async (form) => {
        const values = formValues(form);
        if (scope === "stock") {
          if (values.confirm !== "DELETE") throw new Error("Type DELETE to confirm.");
          await api("/stock/moves", { method: "DELETE" });
        } else {
          await api("/danger/clear", { method: "POST", body: { scope, confirm: values.confirm } });
        }
        toast("Deleted.", "success");
        state.products = [];
        viewCompany();
      },
    }));
  };
  danger("clear-tx", "transactions", "Delete all transactions",
         "Removes every order, invoice, purchase, field entry and stock movement.");
  danger("clear-all", "everything", "Delete everything",
         "Removes all transactions plus every item, customer and supplier.");
  danger("clear-stock", "stock", "Clear stock history",
         "Removes the movement ledger and sets every item's stock to zero.");
  $("#logo-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast("Please choose an image under 2 MB.", "error"); return; }
    const reader = new FileReader();
    reader.onload = () => { logoData = reader.result; $("#logo-preview").src = logoData; };
    reader.readAsDataURL(file);
  });
  $("#logo-clear").addEventListener("click", () => { logoData = ""; $("#logo-preview").removeAttribute("src"); });
  $("#pw-btn").addEventListener("click", passwordModal);
  const backupButton = $("#backup-btn");
  if (backupButton) {
    backupButton.addEventListener("click", () => {
      window.location = "/api/backup";
      toast("Backup downloading - keep it somewhere safe.", "success");
    });
  }

  $("#company-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (readOnly) return;
    const button = $('button[type="submit"]', e.target);
    button.disabled = true;
    try {
      const values = formValues(e.target);
      values.logo = logoData;
      state.company = await api("/company", { method: "PUT", body: values });
      applyBranding();
      toast("Company profile saved.", "success");
    } catch (err) {
      const box = $("#co-error");
      box.textContent = err.message; box.classList.remove("hidden");
    }
    button.disabled = false;
  });
}

function passwordModal() {
  modal({
    title: "Change password",
    body: `
      <label class="field">Current password<input type="password" name="current_password" required></label>
      <label class="field" style="margin-top:14px">New password (6+ characters)
        <input type="password" name="new_password" minlength="6" required></label>`,
    submitLabel: "Update password",
    onSubmit: async (form) => {
      await api("/me/password", { method: "POST", body: formValues(form) });
      toast("Password updated.", "success");
    },
  });
}

// ------------------------------------------------------------------- users

async function viewUsers() {
  const users = await api("/users");
  pageAction("+ New User", () => userModal(null));

  el("content").innerHTML = `
    <p class="muted">Staff accounts can run day-to-day operations. Administrators can additionally
      edit the company profile, manage users and delete invoices.</p>
    ${tableCard(`<th>Username</th><th>Full name</th><th>Role</th><th>Status</th><th>Created</th><th></th>`,
      users.map((u) => `<tr>
        <td class="strong mono">${h(u.username)}</td>
        <td>${h(u.full_name) || `<span class="muted">-</span>`}</td>
        <td>${u.role === "admin" ? `<span class="badge red">Administrator</span>` : `<span class="badge grey">Staff</span>`}</td>
        <td>${u.active ? `<span class="badge green">Active</span>` : `<span class="badge grey">Disabled</span>`}</td>
        <td class="muted">${fmtDate(u.created_at)}</td>
        <td class="row-actions">
          <button class="btn btn-sm" data-edit="${u.id}">Edit</button>
          ${u.id === state.user.id ? "" : `<button class="btn btn-sm btn-danger" data-del="${u.id}">Delete</button>`}
        </td></tr>`).join(""))}`;

  document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click",
    () => userModal(users.find((u) => String(u.id) === b.dataset.edit))));
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const user = users.find((u) => String(u.id) === b.dataset.del);
    confirmDialog(`Delete the account "${user.username}"?`, async () => {
      await api("/users/" + user.id, { method: "DELETE" });
      toast("User deleted.", "success");
      viewUsers();
    }, "Delete user");
  }));
}

function userModal(user) {
  const u = user || { role: "staff", active: 1 };
  modal({
    title: user ? "Edit user" : "New user",
    body: `
      <div class="field-row">
        <label class="field">Username *
          <input name="username" value="${h(u.username || "")}" ${user ? "disabled" : "required"}></label>
        <label class="field">Full name<input name="full_name" value="${h(u.full_name || "")}"></label>
      </div>
      <div class="field-row">
        <label class="field">Role
          <select name="role">
            <option value="staff" ${u.role === "staff" ? "selected" : ""}>Staff</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrator</option>
          </select></label>
        <label class="field">${user ? "New password (leave blank to keep)" : "Password *"}
          <input type="password" name="password" ${user ? "" : "required minlength=6"}></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Account active</label>`,
    submitLabel: user ? "Save changes" : "Create user",
    onSubmit: async (form) => {
      const values = formValues(form);
      if (user) await api("/users/" + user.id, { method: "PUT", body: values });
      else await api("/users", { method: "POST", body: values });
      toast(user ? "User updated." : "User created.", "success");
      viewUsers();
    },
  });
}

// ------------------------------------------------------------------ startup

function applyBranding() {
  const company = state.company;
  document.title = company.name || "Business Management System";
  if (company.demo) {
    el("demo-banner").classList.remove("hidden");
    el("login-demo-banner").classList.remove("hidden");
  }
  el("brand-name").textContent = company.name || "";
  el("brand-tagline").textContent = company.tagline || "";
  el("login-company").textContent = company.name || "";
  if (company.logo) {
    el("brand-logo").src = company.logo;
    el("login-logo").src = company.logo;
  } else {
    el("brand-logo").removeAttribute("src");
    el("login-logo").removeAttribute("src");
  }
}

/**
 * Pings Appwrite when the app opens to verify the setup, and reports the
 * result in the sidebar. Runs after the first render so a slow or unreachable
 * cloud never holds up the app.
 */
async function pingAppwrite() {
  const chip = el("cloud-chip");
  const label = el("cloud-text");
  try {
    const info = await api("/appwrite/ping");
    state.appwrite = info;
    if (!info.ok) {
      chip.className = "cloud-chip bad";
      label.textContent = "Cloud unreachable";
    } else if (!info.has_key) {
      chip.className = "cloud-chip warn";
      label.textContent = "Cloud: needs API key";
    } else {
      chip.className = "cloud-chip ok";
      label.textContent = `Cloud: ${info.schema}`;
    }
    chip.onclick = () => appwriteModal(info);
  } catch (err) {
    chip.className = "cloud-chip bad";
    label.textContent = "Cloud check failed";
    chip.onclick = () => toast(err.message, "error");
  }
}

function appwriteModal(info) {
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:16px;
    padding:7px 0;border-bottom:1px solid var(--line-2)">
    <span class="muted">${h(k)}</span><span class="strong mono">${h(v)}</span></div>`;
  modal({
    title: "Appwrite connection",
    body: `
      ${info.ok
        ? `<p style="margin-top:0">Connected &mdash; the server replied
             <strong>${h(info.reply || "Pong!")}</strong>.</p>`
        : `<div class="form-error">${h(info.error || "Could not reach Appwrite.")}</div>`}
      ${row("Endpoint", info.endpoint)}
      ${row("Project", info.project_name || info.project)}
      ${row("Project ID", info.project)}
      ${row("Database", info.database)}
      ${row("API key", info.has_key ? "configured" : "not set")}
      ${row("Schema", info.schema || "-")}
      ${info.has_key ? "" : `<p class="muted" style="margin:14px 0 0;font-size:12.5px">
        Reads and writes need a server API key. Create one in the Appwrite console
        under <strong>Settings &rarr; API keys</strong>, then start the app with
        <span class="mono">APPWRITE_KEY=...</span> set.</p>`}`,
  });
}

function showLogin(offline) {
  state.user = null;
  el("app").classList.add("hidden");
  el("login-screen").classList.remove("hidden");
  setOfflineNotice(offline === true || !navigator.onLine);
  closeModal();
}

/**
 * Signing in needs the server, so with no connection the form is a dead end.
 * Say so plainly and point at the field form, which does work offline.
 */
function setOfflineNotice(offline) {
  el("offline-notice").classList.toggle("hidden", !offline);
  el("login-hint").classList.toggle("hidden", offline);
  // The inputs are required; leaving them hidden but present would make the
  // browser refuse the submit with an error about a non-focusable control.
  el("login-fields").classList.toggle("hidden", offline);
  el("login-submit").classList.toggle("hidden", offline);
  el("login-fields").querySelectorAll("input").forEach((input) => {
    input.required = !offline;
    input.disabled = offline;
  });
}

async function showApp(user) {
  state.user = user;
  state.company = await api("/company");
  applyBranding();
  el("user-name").textContent = user.full_name || user.username;
  el("user-role").textContent = user.role === "admin" ? "administrator" : "staff";
  el("user-avatar").textContent = (user.full_name || user.username).charAt(0).toUpperCase();
  // With sign-in switched off there is nothing to sign out of.
  el("logout-btn").classList.toggle("hidden", state.company.login_required === false);
  el("login-screen").classList.add("hidden");
  el("app").classList.remove("hidden");
  buildNav();
  showConnectionBanner();
  if (!location.hash) location.hash = "#/dashboard";
  router();
  pingAppwrite();
}

el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorBox = el("login-error");
  const button = $('button[type="submit"]', e.target);
  errorBox.classList.add("hidden");
  button.disabled = true;
  try {
    const result = await api("/login", { method: "POST", body: formValues(e.target) });
    e.target.reset();
    state.products = [];
    await showApp(result.user);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove("hidden");
  }
  button.disabled = false;
});

el("logout-btn").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST" }); } catch (_) { /* already gone */ }
  location.hash = "";
  showLogin();
});

function toggleNav(open) {
  const sidebar = el("sidebar");
  const show = open === undefined ? !sidebar.classList.contains("open") : open;
  sidebar.classList.toggle("open", show);
  el("scrim").classList.toggle("show", show);
  document.body.classList.toggle("nav-open", show);
}

el("menu-btn").addEventListener("click", () => toggleNav());
el("scrim").addEventListener("click", () => toggleNav(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (el("modal-root").innerHTML) closeModal(); else toggleNav(false);
});
window.addEventListener("hashchange", () => { if (state.user) router(); });
function showConnectionBanner() {
  const bar = el("net-banner");
  if (!bar) return;
  bar.classList.toggle("hidden", navigator.onLine);
}
window.addEventListener("offline", () => {
  showConnectionBanner();
  if (!state.user) setOfflineNotice(true);
});
window.addEventListener("online", () => {
  showConnectionBanner();
  if (state.user) { router(); return; }   // reload the screen now data is reachable
  setOfflineNotice(false);
  location.reload();
});

// Any table rendered into the page or a modal gets its cells labelled.
const tableWatcher = new MutationObserver(() => labelTableCells());
tableWatcher.observe(el("content"), { childList: true, subtree: true });
tableWatcher.observe(el("modal-root"), { childList: true, subtree: true });

// Installable to the home screen. Needs HTTPS (or localhost) - over plain
// http the browser never fires this and the button stays hidden.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  el("install-chip").classList.remove("hidden");
});
el("install-chip").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  el("install-chip").classList.add("hidden");
});
window.addEventListener("appinstalled", () => el("install-chip").classList.add("hidden"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* not a secure context */ });
}

(async function boot() {
  try {
    const me = await api("/me");
    await showApp(me.user);
  } catch (err) {
    let offline = err.offline === true;
    try {
      state.company = await api("/branding");
      applyBranding();
    } catch (second) {
      offline = offline || second.offline === true;
    }
    showLogin(offline);
  }
})();

})();
