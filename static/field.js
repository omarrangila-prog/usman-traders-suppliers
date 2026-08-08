/* Field booking - works with no connection, syncs itself when one returns.
 *
 * Entries are written to localStorage the moment Save is pressed, so nothing
 * depends on the network. A queued entry carries a client_id generated here;
 * the server treats that as the identity of the entry, so a retry after a lost
 * reply can never create the booking twice.
 */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const QUEUE_KEY = "utf_queue";
const CACHE_KEY = "utf_cache";
const DEVICE_KEY = "utf_device";

let catalogue = { products: [], customers: [], suppliers: [], company: "" };
let kind = "Booking";
let lines = [];
let syncing = false;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function device() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = uuid().slice(0, 8); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
                          catch (_) { return []; } };
const writeQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));

function money(n) {
  return "PKR " + Number(n || 0).toLocaleString("en-PK",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function h(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(message, kindName) {
  const node = document.createElement("div");
  node.className = "toast " + (kindName || "");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

// ------------------------------------------------------------------ catalogue

function applyCatalogue(data) {
  catalogue = data;
  $("company").textContent = data.company || "Usman Traders & Suppliers";
  const names = kind === "Purchase" ? data.suppliers : data.customers;
  $("party-list").innerHTML = (names || []).map((n) => `<option value="${h(n)}">`).join("");
  renderLines();
}

async function loadCatalogue() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) { try { applyCatalogue(JSON.parse(cached)); } catch (_) { /* ignore */ } }
  try {
    const res = await fetch("/api/field/bootstrap", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    applyCatalogue(data);
  } catch (_) {
    // offline: the cached copy above is what we work from
  }
}

// ---------------------------------------------------------------------- lines

function renderLines() {
  if (!lines.length) lines = [{ sku: "", qty: 1, price: 0 }];
  const options = catalogue.products.map((p) =>
    `<option value="${h(p.sku)}">${h(p.sku)} - ${h(p.name)}</option>`).join("");

  $("lines").innerHTML = lines.map((line, i) => `
    <div class="line">
      <button class="rm" data-rm="${i}" type="button">&times;</button>
      <label>Item
        <select data-i="${i}" data-f="sku">
          <option value="">Choose an item...</option>${options}
        </select>
      </label>
      <div class="two">
        <label>Quantity
          <input type="number" inputmode="decimal" step="0.01" min="0"
                 data-i="${i}" data-f="qty" value="${h(line.qty)}"></label>
        <label>Rate
          <input type="number" inputmode="decimal" step="0.01" min="0"
                 data-i="${i}" data-f="price" value="${h(line.price)}"></label>
      </div>
      <div class="amt">${money(Number(line.qty || 0) * Number(line.price || 0))}</div>
    </div>`).join("");

  lines.forEach((line, i) => {
    const select = document.querySelector(`select[data-i="${i}"]`);
    if (select) select.value = line.sku || "";
  });

  document.querySelectorAll("[data-f]").forEach((input) => {
    input.addEventListener("change", (e) => {
      const { i, f } = e.target.dataset;
      lines[i][f] = f === "sku" ? e.target.value : Number(e.target.value || 0);
      if (f === "sku") {
        const product = catalogue.products.find((p) => p.sku === e.target.value);
        if (product) {
          lines[i].price = Number(
            kind === "Purchase" ? product.purchase_price : product.sale_price) || 0;
          lines[i].name = product.name;
          lines[i].unit = product.unit;
        }
      }
      renderLines();
    });
  });
  document.querySelectorAll("[data-rm]").forEach((button) => {
    button.addEventListener("click", (e) => {
      lines.splice(Number(e.currentTarget.dataset.rm), 1);
      renderLines();
    });
  });

  $("total").textContent = money(
    lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0));
}

// ----------------------------------------------------------------- the queue

function renderQueue() {
  const queue = readQueue();
  const waiting = queue.filter((e) => !e.synced);
  $("pending-bar").classList.toggle("hidden", waiting.length === 0);
  $("pending-text").textContent =
    `${waiting.length} ${waiting.length === 1 ? "entry" : "entries"} waiting to sync`;

  $("queue").innerHTML = queue.length
    ? queue.slice().reverse().slice(0, 25).map((e) => `
        <div class="qrow">
          <span>${h(e.party_name || "(no name)")}
            <span style="color:var(--ink-3)"> &middot; ${h(e.kind)} &middot; ${money(
              (e.items || []).reduce((s, i) => s + i.qty * i.price, 0))}</span></span>
          <span class="pill ${e.synced ? "done" : "wait"}">${e.synced ? "Synced" : "Waiting"}</span>
        </div>`).join("")
    : "Nothing saved yet.";
}

function save() {
  const party = $("party").value.trim();
  if (!party) { toast("Enter the shop or customer name.", "err"); $("party").focus(); return; }
  const chosen = lines.filter((l) => l.sku && Number(l.qty) > 0);
  if (!chosen.length) { toast("Add at least one item.", "err"); return; }

  const entry = {
    client_id: uuid(),
    kind,
    party_name: party,
    phone: $("phone").value.trim(),
    city: $("city").value.trim(),
    entry_date: $("date").value || new Date().toISOString().slice(0, 10),
    notes: $("notes").value.trim(),
    items: chosen.map((l) => ({
      sku: l.sku, name: l.name || "", unit: l.unit || "",
      qty: Number(l.qty), price: Number(l.price),
    })),
    captured_at: new Date().toISOString(),
    synced: false,
  };

  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);

  lines = [];
  $("party").value = ""; $("phone").value = ""; $("notes").value = "";
  renderLines();
  renderQueue();
  toast(navigator.onLine ? "Saved — syncing…" : "Saved on this phone. It will sync automatically.",
        "ok");
  sync();
}

async function sync() {
  if (syncing || !navigator.onLine) return;
  const queue = readQueue();
  const waiting = queue.filter((e) => !e.synced);
  if (!waiting.length) return;

  syncing = true;
  try {
    const res = await fetch("/api/field/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: device(), entries: waiting }),
    });
    if (!res.ok) throw new Error("Server replied " + res.status);
    const result = await res.json();
    // Both freshly stored and already-known ids count as safely delivered.
    const done = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
    const updated = readQueue().map((e) =>
      done.has(e.client_id) ? Object.assign({}, e, { synced: true }) : e);
    writeQueue(updated);
    renderQueue();
    if (result.stored) toast(`${result.stored} sent to the office.`, "ok");
    loadCatalogue();
  } catch (err) {
    // stay queued and try again on the next connection or tick
  } finally {
    syncing = false;
  }
}

function showNetwork() {
  const online = navigator.onLine;
  $("net").classList.toggle("off", !online);
  $("net-text").textContent = online ? "Online" : "Offline";
  if (online) sync();
}

// ------------------------------------------------------------------- startup

document.querySelectorAll(".seg button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".seg button").forEach((b) => b.classList.remove("on"));
    button.classList.add("on");
    kind = button.dataset.kind;
    $("party-heading").textContent = kind === "Purchase" ? "Supplier" : "Shop / customer";
    $("save").textContent = kind === "Purchase" ? "Save purchase" : "Save booking";
    const names = kind === "Purchase" ? catalogue.suppliers : catalogue.customers;
    $("party-list").innerHTML = (names || []).map((n) => `<option value="${h(n)}">`).join("");
    lines.forEach((l) => {
      const product = catalogue.products.find((p) => p.sku === l.sku);
      if (product) l.price = Number(
        kind === "Purchase" ? product.purchase_price : product.sale_price) || 0;
    });
    renderLines();
  });
});

$("add-line").addEventListener("click", () => { lines.push({ sku: "", qty: 1, price: 0 }); renderLines(); });
$("save").addEventListener("click", save);
$("sync-now").addEventListener("click", () => { showNetwork(); sync(); });
$("clear").addEventListener("click", () => {
  lines = []; $("party").value = ""; $("phone").value = "";
  $("city").value = ""; $("notes").value = "";
  renderLines();
});

window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(sync, 30000);          // catch connections that return quietly

$("date").value = new Date().toISOString().slice(0, 10);
renderLines();
renderQueue();
showNetwork();
loadCatalogue();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* http-only host */ });
}

})();
