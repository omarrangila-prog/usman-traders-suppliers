Two new reports: **who brought the work in**, and **what it actually earned**.

## Booker report

Bookings recorded only which phone they came from — a device number, no use for
asking someone about an order or for paying commission on it.

The booking form now asks the booker's name once and remembers it on that phone.
The name travels with the booking, onto the order it becomes, and onto the
invoice after that — so the office can see, per person:

- bookings taken, and how many are **still waiting** to be dealt with
- the value they booked
- orders raised from those bookings
- **invoiced, collected, and still owed**

**Reports → Booker report.** Field Entries now names the person too, instead of
showing a device number.

## Costing and profit

**Reports → Costing & profit.** Item by item: what it costs, what it sells for,
what one unit makes, how many sold, and the profit and margin on them.

It also flags two things worth knowing about:

- items **priced below what they cost** — every sale loses money
- items with **no cost recorded**, which look like pure profit until a purchase
  sets one

Cost is the price last paid for the item, which is what the books value stock
at. That is deliberate: the profit shown here is the same profit the accounts
report, not a second opinion that disagrees with them. The test checks that they
match.

Both reports download to Excel like the others.

## What was checked

The figures are worked out on paper first, then compared: two bookers, three
bookings, one still pending, known prices and known costs. Asif books 1,400,
converts one, invoices 1,000, collects 400, is owed 600. 160 units sold at 10
bought at 6 gives revenue 1,600, cost 960, profit 640, margin 40% — and the
accounts agree.

That runs alongside the existing 25 hand-computed figures, 81 operations, a day
in the shop across all screens, 54 sharing checks and 30 awkward situations.

## One fix

A test was written against fixed dates in August while checking figures the
program reports for "this month". It passed in August and would have failed on
the first of every month afterwards, for no real reason. It now uses the current
month.
