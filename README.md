# Usman Traders & Suppliers — Business Management System

A simple business management system for a trading and supply company: purchase,
manage and supply achar, masala, syrups, oils and other food items. No
manufacturing — buying, stock, selling and delivery only.

Two ways to run it, sharing one interface and one set of business rules:

- **Windows program** — a real desktop application. Nothing to install beyond
  it, no internet, all data in one file on that computer.
- **Web version** — the same system in a browser, for the office and for
  phones taking bookings in the field. Runs on the **Python standard library
  alone**.

---

## Windows program

A real Windows application. Electron draws the window, the program holds your
data itself, and nothing runs as a server: there is no port, no address to
type, and no browser involved. It works with no internet because there is
nothing for it to reach.

Two ways to get it, from the
[Releases page](https://github.com/omarrangila-prog/usman-traders-suppliers/releases):

| File | What it does |
| --- | --- |
| `UsmanTraders-Setup-<version>.exe` | Installs it properly, with a Start-menu and desktop shortcut. Use this one. |
| `UsmanTraders-Portable-<version>.exe` | Runs without installing. Handy on a machine you cannot install software on. |

Windows will warn you the first time — **More info → Run anyway**. That is
because the program is not code-signed, which needs a paid yearly certificate,
not because anything is wrong with it.

### Where your data lives

One file on that computer:

```
C:\Users\<you>\AppData\Roaming\Usman Traders & Suppliers\usmantraders.db
```

The program tells you the exact path under **Help → About**, and the sidebar
chip at the bottom left opens the folder. **File → Save a backup** writes a
copy wherever you choose — do that regularly, because that single file is your
whole business record.

### Checking an installation

Run it once with `--self-check` and it proves itself on that machine: opens a
window, loads the interface, reads the data, and reports what passed.

```
"C:\...\Usman Traders & Suppliers.exe" --self-check
```

That same check runs on a clean Windows machine in the build pipeline, and a
build that fails it is never published.

### Building it yourself

```bash
cd electron
npm install
npm test          # 25 hand-computed figures, 79 operational checks
npm start         # run it
npx electron-builder --win    # build the installer
```

## Running it

```bash
cd ~/Projects/Usman Traders
python3 app.py          # then open http://localhost:8000
```

Use a different port by passing it: `python3 app.py 9000`.
Stop the server with `Ctrl+C`.

**There is no sign-in.** The app opens straight to the dashboard and runs as
the administrator, so nothing stands between you and the day's work.

To switch the login screen back on:

```bash
UT_LOGIN=on python3 app.py     # then sign in as admin / admin123
```

Leave it off only on a machine you trust, since anyone who can reach the
address can see and change everything. The accounts, roles and passwords are
all still there, unused, until you turn it back on.

To let staff use it from other computers on the same shop/office network, they
open `http://<this-computer-ip>:8000`.

---

## What is already loaded

- **Company profile** — Usman Traders & Suppliers, currency PKR.
- **64 items** — your full item master (codes `00001`–`00063`, plus `000049`).
  Descriptions are kept exactly as you supplied them so they match the codes you
  already use.
- **Sale prices** filled in wherever the price appears in the description
  (`SARSO OIL RS 60` → 60). Items with no price in the name are left at 0.
- **Cost prices and opening stock are 0** — enter them yourself, either by
  editing each product or by recording your first purchase.
- **No customers or suppliers.** Deliberate: placeholder names in a live ledger
  end up on real invoices. Add your own from the Customers and Suppliers pages.

### The logo

Your company mark — the cream disc with **عثمان** in red Nastaliq over
**ٹریڈرز اینڈ سپلائرز** — is built in (`static/logo.png`) and appears on the
sidebar, the browser tab and every invoice.

It is a rebuild of the artwork you supplied, not the original file. To drop in
your exact artwork: **Company Profile → Upload logo**, choose the image, then
**Save Company Profile**. That replaces it everywhere and is never overwritten
by updates.

---

## Daily use

| Screen | What it is for |
|---|---|
| **Dashboard** | Month's sales and purchases, money owed to you and by you, stock value, low-stock alerts |
| **Orders** | Take a customer order, edit it, track it, turn it into an invoice |
| **Deliveries** | Everything still to go out, and its stage |
| **Invoices** | Bills, payments received, print / save as PDF |
| **Purchases** | Supplier bills, goods received into stock, payments made |
| **Suppliers / Customers** | Contact books; customers also have an account ledger |
| **Products** | The item master — add, edit, delete |
| **Inventory** | Stock on hand, value, adjustments, full movement history |
| **Reports** | Sales, purchases and inventory reports for any date range, downloadable as Excel |
| **Company Profile** | Business details, logo, currency, invoice footer |
| **Users & Access** | Staff accounts (admin only) |

### How stock moves

Nothing is calculated by hand. Enter the transaction and the stock follows:

| You do this | Stock does this |
|---|---|
| Record a purchase | Goes **up** by the quantity bought |
| Mark an order **Delivered** | Goes **down** — that is when goods leave |
| Save a counter-sale invoice | Goes **down** immediately |
| Delete any of the above | Reverses itself |

The status (In Stock / Low Stock / Out of Stock) follows the quantity against
each item's reorder level, with no action from you. Every change is written to
the movement ledger, and the ledger always sums to the stock on hand.

The detail:

- Recording a purchase as **Received** → stock **goes up**.
- Marking an order **Delivered** → stock **goes down**.
  Moving it back out of Delivered puts the stock back.
- A **direct invoice** (a counter sale with no order behind it) takes stock
  **immediately**.
- An invoice made **from an order** does not touch stock — the order already did.
- **Inventory → Adjust Stock** for damage, wastage or a physical count
  correction. Positive adds, negative removes.

Every one of these is written to the movement history, so any stock figure can
be traced back.

### Orders → invoices

Open an order → **Generate Invoice**. The invoice copies the order's lines and
totals. Once an order is invoiced it is locked from editing, so the bill and the
order can never disagree. Record part payments as they come in; the invoice
shows Unpaid → Partial → Paid by itself.

### Excel reports

Every report has a **⤓ Download Excel** button, and the Products screen has
**⤓ Excel** for the full item master. These are real `.xlsx` workbooks, not CSV
files renamed — each opens with:

- **Separate tabs** — Summary, By Customer, By Item, Day by Day (and By
  Supplier / By Category / Stock List on the other reports).
- A title and the date range at the top of every sheet.
- **Frozen header rows** so the columns stay visible as you scroll, with
  filter arrows already switched on.
- Amounts as **real numbers** formatted `#,##0.00` — you can sum, sort, pivot
  and chart them straight away.
- A shaded **totals row** at the bottom of each table.

Nothing is installed to produce these; the workbook is written directly.

### Printing

**Print / PDF** on any invoice opens your browser's print dialog — choose
"Save as PDF" to email it, or print it for the customer. Reports print too.

---

## Users

- **Administrator** — everything, plus company profile, staff accounts and
  deleting invoices.
- **Staff** — day-to-day work: orders, invoices, purchases, stock, contacts.

Passwords are stored as PBKDF2-SHA256 hashes (200,000 rounds) with a per-user
salt — never as plain text. Sessions are HttpOnly cookies that expire after 12
hours.

---

## Your data

Everything lives in **`usmantraders.db`** in this folder.

**Back it up by copying that one file.** Do it regularly — to a USB stick or
another drive. The easiest way is **Company Profile → Download backup now**,
which hands you a dated copy without stopping the server. To restore, put the
file back beside `app.py` named `usmantraders.db` and start the server again.

Deleting `usmantraders.db` and restarting gives you a fresh system with the item
master re-seeded and the default admin login.

---

## Deploying for real use

The app is a PWA: the admin app installs from `/`, the field form from
`/field.html`, both from the same address.

### Going online in one command

`tools/cloudflared` gives the app a public HTTPS address with no account, no
domain and no port forwarding:

```bash
python3 app.py                                   # terminal 1
./tools/cloudflared tunnel --url http://localhost:8000   # terminal 2
```

It prints a `https://….trycloudflare.com` link. That link works from anywhere,
installs as a PWA on Android and iPhone, and syncs field entries over the
internet. The address changes each time it restarts — for a fixed one, log in
to a free Cloudflare account and create a named tunnel.

### HTTPS is required — this is not optional

Browsers only allow service workers and app installation on **HTTPS** (or
`localhost`). Over plain `http://192.168.x.x:8000` the `serviceWorker` API is
not even present, so there is **no offline mode and no install button**.

Any of these gives you HTTPS:

| Option | Notes |
|---|---|
| **Cloudflare Tunnel** | Free, no fixed IP or port forwarding needed. `cloudflared tunnel --url http://localhost:8000` |
| **Caddy in front** | Free certificate, one line of config, if you have a domain |
| **A small VPS** | ~$5/month, run the app behind Caddy or nginx |

### Environment

```bash
UT_LOGIN=on                  # default; 'off' removes the login screen
UT_SECRET=<long random>      # required if more than one server process
DATABASE_URL=postgresql://...        # optional; SQLite is used when unset
```

`GET /api/health` reports the storage engine and login mode for uptime checks.

### Before handing it to a client

- [ ] Serve over HTTPS
- [ ] Change the `admin` password
- [ ] Set `UT_SECRET`
- [ ] Schedule a copy of `usmantraders.db` somewhere off the machine

## Where it lives

| | |
|---|---|
| **Code** | https://github.com/omarrangila-prog/usman-traders-suppliers (private) |
| **Online demo** | ask the owner &mdash; the address is not published here |

### The online version is a demo, not your books

Vercel runs the app without a permanent disk, and it runs **several copies at
once**. Each copy keeps its own scratch database in temporary storage, so:

- Data is **wiped** whenever a copy restarts — usually minutes after going idle.
  It comes back with the 64-item master and a fresh `admin` login.
- Something you save may **not appear** on a later screen, if that click was
  answered by a different copy.

Staying signed in is solved (sessions are signed cookies that every copy
accepts), but the data problem cannot be fixed without a shared database. A
warning band sits across the top so nobody mistakes the demo for the real thing.

Use it to **show** the system. **Keep your actual records on the copy running on
your own computer** (`python3 app.py`), where the data lives in `usmantraders.db`
and stays put.

### Making the online version permanent

The app already speaks Postgres as well as SQLite. Give it a connection string
and it stores data properly, with no code changes:

```bash
# locally
DATABASE_URL="postgresql://user:pass@host/dbname" python3 app.py

# on Vercel
vercel env add DATABASE_URL production     # paste the string when prompted
vercel deploy --prod
```

A free database from [neon.tech](https://neon.tech) or
[supabase.com](https://supabase.com) is plenty — neither needs a card. The
tables and the 64-item master are created automatically on first connection.
Set `UT_SECRET` too (any long random string) so signed-in sessions are
accepted by every server copy.

Which engine is in use is decided purely by whether `DATABASE_URL` is set, so
the same code runs on your laptop and in the cloud.

### Updating either one

```bash
git add -A && git commit -m "what changed" && git push   # GitHub
vercel deploy --prod                                     # the demo site
```

To make the GitHub repo public:

```bash
gh repo edit omarrangila-prog/usman-traders-suppliers --visibility public
```

---

## On a phone

The whole system is built for phone use, not just squeezed onto one:

- Tap **☰** for the menu; tap outside it to close.
- Every table becomes one card per record with labelled fields — no pinching or
  sideways scrolling.
- Forms open as full-height sheets with the Save button pinned to the bottom.
- Order and purchase lines stack into cards, one item each.
- Input boxes are sized so phones don't zoom when you tap them.

---

## Files

| File | Contents |
|---|---|
| `app.py` | Web server and the whole API |
| `db.py` | Database schema, password hashing, first-run seed data |
| `static/index.html` | Page shell |
| `static/styles.css` | All styling, including the print layout |
| `static/app.js` | The user interface |
| `usmantraders.db` | Your data (created on first run) |
