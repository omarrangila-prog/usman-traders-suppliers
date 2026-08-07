# Usman Traders & Suppliers — Business Management System

A simple business management system for a trading and supply company: purchase,
manage and supply achar, masala, syrups, oils and other food items. No
manufacturing — buying, stock, selling and delivery only.

Runs on the **Python standard library alone**. Nothing to install, no internet
needed, all data stays in one file on your machine.

---

## Running it

```bash
cd ~/Projects/SupplyDesk
python3 app.py          # then open http://localhost:8000
```

Use a different port by passing it: `python3 app.py 9000`.
Stop the server with `Ctrl+C`.

**First sign-in:** username `admin`, password `admin123`.
Change it immediately from *Company Profile → Change my password*.

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

A stand-in "UT" mark in your brand colours is in place. To use your real logo:
**Company Profile → Upload logo**, pick the image file, then **Save Company
Profile**. It then appears on the sidebar, the sign-in screen and every invoice.

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

This is the one rule worth knowing:

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

Everything lives in **`supplydesk.db`** in this folder.

**Back it up by copying that one file.** Do it regularly — to a USB stick or
another drive. The easiest way is **Company Profile → Download backup now**,
which hands you a dated copy without stopping the server. To restore, put the
file back beside `app.py` named `supplydesk.db` and start the server again.

Deleting `supplydesk.db` and restarting gives you a fresh system with the item
master re-seeded and the default admin login.

---

## Where it lives

| | |
|---|---|
| **Code** | https://github.com/omarrangila-prog/usman-traders-suppliers (private) |
| **Online demo** | https://usman-traders-suppliers.vercel.app |

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
your own computer** (`python3 app.py`), where the data lives in `supplydesk.db`
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
Set `SUPPLYDESK_SECRET` too (any long random string) so signed-in sessions are
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
| `supplydesk.db` | Your data (created on first run) |
