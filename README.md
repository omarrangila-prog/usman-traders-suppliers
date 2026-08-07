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
| **Reports** | Sales, purchases and inventory reports for any date range |
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
another drive. Copy it while the server is stopped for a guaranteed-clean copy.
To restore, put the file back and start the server again.

Deleting `supplydesk.db` and restarting gives you a fresh system with the item
master re-seeded and the default admin login.

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
