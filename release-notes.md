Your bookers' orders now come through to the desktop — today, without waiting
for anything to be fixed on the web site.

## The short version

Press **Share now** in the desktop program and every booking your men have taken
on their phones appears in **Field Entries**, ready to turn into a real order
with one click. Doing it twice never gives you the same booking twice.

Tested against your live site: **all 8 bookings** came through with their shop
names, phone numbers and item lines intact.

## Why this release exists

Full two-way sharing shipped in v2.1.0, but it needs the web site to be running
a matching version — and **your web site has not updated since 16 August**. Every
deployment since has failed on Vercel with *Not authorized*, no build log, and
no error shown. That is an account problem, not a fault in the software, and it
is not something the program can fix.

Rather than leave the office blind to its own bookings until that is sorted, the
desktop now reads them straight out of the part of the web site that has always
worked. It sends nothing and changes nothing there — it only brings the bookings
in. When the web site is finally updated, full two-way sharing switches on by
itself with no change here.

## A real bug this found

Creating an order after a sync could fail with a duplicate-number error. The
program took the next document number from the most recent row, but records
arriving from the web site are written in whatever order the merge reaches them,
so the newest row is not the highest number. It now takes the highest number
actually in use. Nobody had hit it yet; the test did.

## What is checked before a release is published

- **25 figures** worked out by hand and compared against what the program reports
- **79 operations** — buying, delivering, invoicing, collecting, deleting,
  year-end close, roles and passwords
- **A day in the shop** — buy from a vendor, take an order, deliver, invoice,
  take part payment, check the figures, and open all 24 screens
- **52 sharing checks** — the real web server and the real desktop program made
  to talk over HTTP, covering no duplication, work flowing both ways, bookings
  arriving, deletions staying deleted, clashes being kept rather than lost, and
  both sides ending with identical document numbers
- The installer is then installed on a clean Windows machine, and the installed
  program must open a window, sign in, draw the dashboard and read back the item
  master — **16 self-checks**

A build that fails any of it is not published.
