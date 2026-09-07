**Bookers Report** now has its own place in the menu, under Insights, rather
than being buried in a dropdown. **Costing & Profit** is beside it.

Both still work as tabs on the Reports screen, and both still download to Excel.

## A fault in that change, caught before release

Giving them their own menu entries meant the Reports screen could be opened
straight onto a chosen report. The screen was written to fall back to the sales
report when nothing was named — but the menu hands a view an empty list, and an
empty list counts as *something* in JavaScript. The Reports screen would have
opened onto nothing at all. It now insists on an actual name.

## Prices corrected in your live data

Every order line was compared against the item master. Four differed; two were
unmistakable and have been corrected:

| Order | Shop | What was wrong | Now |
| --- | --- | --- | --- |
| ORD-0003 | B s gernal store | `00001` at Rs 100 each — three other orders sell the identical line at Rs 10 | Rs 10 · order **2,400 → 240** |
| ORD-0004 | Nosheen General St | `00040` at Rs 0 — free. ORD-0008 sells the identical line at Rs 10 | Rs 10 · order **960 → 1,200** |

`00040 SAVHET RED CHILLI POWDER` had no price in the item master at all, which
is how it could be booked free. It is now Rs 10, the price it is sold at
everywhere else.

All ten orders were Pending, undelivered and uninvoiced, so nothing had to be
unwound and no stock or accounting entry was affected.

**Two were left alone**, because guessing would have been a ten-fold error
either way — see below.

## What still needs asking

Two orders read *quantity 1 at Rs 100* for items listed at Rs 10:

- **ORD-0005 — Subhnai store** — `00001` ACHAR SACHET RS;10
- **ORD-0010 — Mehar general store** — `00060` AJEENO MOTO SACHET RS10

Either the quantity is wrong (10 pieces at Rs 10 = Rs 100, total correct) or the
price is (1 piece at Rs 10 = Rs 10, total wrong). Only the booker knows which.
Both are untouched until you have asked.
