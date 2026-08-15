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
  (catalogue.products || []).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
  $("company").textContent = data.company || "Usman Traders & Suppliers";
  renderParties();
  renderLines();
}

/** The known shops as a list you can see, with room to add a new one. */
function renderParties() {
  const names = (kind === "Purchase" ? catalogue.suppliers : catalogue.customers) || [];
  const chosen = $("party-pick").value;
  $("party-pick").innerHTML =
    `<option value="">${names.length ? "Choose a " + (kind === "Purchase" ? "supplier" : "shop")
                                     + "..." : "No saved names yet"}</option>` +
    names.map((n) => `<option value="${h(n)}">${h(n)}</option>`).join("") +
    `<option value="__new">+ Someone new</option>`;
  if (chosen && (names.includes(chosen) || chosen === "__new")) $("party-pick").value = chosen;
  $("party-pick-label").classList.toggle("hidden", !names.length);
  showNameBox(!names.length || $("party-pick").value === "__new");
}

function showNameBox(show) {
  $("party-name-label").classList.toggle("hidden", !show);
  if (show) $("party").value = $("party").value || "";
}

/** Whichever way the name was given. */
function partyName() {
  const picked = $("party-pick").value;
  if (picked && picked !== "__new") return picked;
  return $("party").value.trim();
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
  const empty = !(catalogue.products || []).length;
  $("no-items").classList.toggle("hidden", !empty);
  $("lines").classList.toggle("hidden", empty);
  $("add-line").classList.toggle("hidden", empty);
  if (empty) { $("total").textContent = money(0); return; }
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
  const waiting = queue.filter((e) => !e.synced && !e.failed);
  $("pending-bar").classList.toggle("hidden", waiting.length === 0);
  $("pending-text").textContent =
    `${waiting.length} ${waiting.length === 1 ? "entry" : "entries"} waiting to sync`;

  $("queue").innerHTML = queue.length
    ? queue.slice().reverse().slice(0, 25).map((e) => `
        <div class="qrow">
          <span>${h(e.party_name || "(no name)")}
            <span style="color:var(--ink-3)"> &middot; ${h(e.kind)} &middot; ${money(
              (e.items || []).reduce((s, i) => s + i.qty * i.price, 0))}</span></span>
          <span class="pill ${e.synced ? "done" : e.failed ? "err" : "wait"}">${
            e.synced ? "Synced" : e.failed ? "Needs attention" : "Waiting"}</span>
        </div>`).join("")
    : "Nothing saved yet.";
}

function save() {
  const party = partyName();
  if (!party) {
    toast("Choose a shop or type a new name.", "err");
    ($("party-name-label").classList.contains("hidden") ? $("party-pick") : $("party")).focus();
    return;
  }
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
  $("party-pick").value = "";
  renderParties();
  renderLines();
  renderQueue();
  toast(navigator.onLine ? "Saved — syncing…" : "Saved on this phone. It will sync automatically.",
        "ok");
  sync();
}

/* Retry timing. A flaky signal must not turn into a request storm, so each
   failed attempt waits longer, capped at five minutes. */
const BACKOFF = [0, 5e3, 15e3, 60e3, 180e3, 300e3];
let failUntil = 0;

function isDue(entry) {
  return !entry.synced && !entry.failed && (entry.next_try || 0) <= Date.now();
}

async function sync() {
  if (syncing || !navigator.onLine || Date.now() < failUntil) return;
  const waiting = readQueue().filter(isDue);
  if (!waiting.length) return;

  syncing = true;
  try {
    const controller = new AbortController();
    const bail = setTimeout(() => controller.abort(), 20000);   // dead-air connections
    const res = await fetch("/api/field/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: device(), entries: waiting }),
      signal: controller.signal,
    });
    clearTimeout(bail);

    // A captive portal answers 200 with a login page, not our JSON.
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("application/json")) {
      throw new Error("unexpected reply " + res.status);
    }
    const result = await res.json();

    // Stored now or already known - either way the office has it.
    const done = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
    const attempted = new Set(waiting.map((e) => e.client_id));
    const updated = readQueue().map((entry) => {
      if (done.has(entry.client_id)) {
        return Object.assign({}, entry, { synced: true, synced_at: new Date().toISOString() });
      }
      if (attempted.has(entry.client_id)) {
        // Sent but not acknowledged: the server rejected this one specifically.
        const attempts = (entry.attempts || 0) + 1;
        return Object.assign({}, entry, {
          attempts,
          failed: attempts >= 3,
          error: "The office could not accept this entry.",
          next_try: Date.now() + BACKOFF[Math.min(attempts, BACKOFF.length - 1)],
        });
      }
      return entry;
    });
    writeQueue(prune(updated));
    renderQueue();
    if (result.stored) toast(`${result.stored} sent to the office.`, "ok");
    loadCatalogue();
  } catch (err) {
    // Connection problem: keep everything queued, just slow the retries down.
    const updated = readQueue().map((entry) => {
      if (!isDue(entry)) return entry;
      const attempts = (entry.attempts || 0) + 1;
      return Object.assign({}, entry, {
        attempts,
        next_try: Date.now() + BACKOFF[Math.min(attempts, BACKOFF.length - 1)],
      });
    });
    writeQueue(updated);
    failUntil = Date.now() + 5000;
    renderQueue();
  } finally {
    syncing = false;
  }
}

/* Delivered entries are kept briefly as a visible receipt, then dropped so the
   queue cannot grow without limit on a phone used every day. */
function prune(queue) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const keep = queue.filter((e) =>
    !e.synced || !e.synced_at || Date.parse(e.synced_at) > cutoff);
  return keep.length > 300 ? keep.slice(-300) : keep;
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
    renderParties();
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
$("party-pick").addEventListener("change", () => showNameBox($("party-pick").value === "__new"));
$("clear").addEventListener("click", () => {
  lines = []; $("party").value = ""; $("phone").value = "";
  $("city").value = ""; $("notes").value = "";
  $("party-pick").value = "";
  renderParties();
  renderLines();
});

window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(sync, 30000);          // catch connections that return quietly

$("date").value = new Date().toISOString().slice(0, 10);
renderParties();
renderLines();
renderQueue();
showNetwork();
loadCatalogue();

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-bar").classList.remove("hidden");
});
$("install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("install-bar").classList.add("hidden");
});
window.addEventListener("appinstalled", () => $("install-bar").classList.add("hidden"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    // Chrome/Android can flush the queue after the app is closed.
    if ("sync" in reg) reg.sync.register("utf-sync").catch(() => {});
  }).catch(() => { /* needs https - see the deployment notes */ });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "sync-now") sync();
  });
}

})();
