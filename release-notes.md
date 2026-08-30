Four faults found and fixed. None of them had been hit yet — they were found by
going looking for the same *kind* of mistake as the numbering bug in v2.1.1:
things that are true on one machine and stop being true once records arrive from
another.

## What was wrong

**Deleting something the other machine was still using stopped everything.**
Remove a customer at the office while the web site has an order for them, and
the whole exchange was abandoned with a database error — no bookings in, no work
out, every time, until someone worked out which record was to blame. Deletions
are now applied in the right order, and a record another machine is still using
is kept rather than deleted, with the disagreement recorded so you can see it.

**"The newer change wins" was not true.** The mark saying when a record last
changed was written once and never moved, so it recorded when a record was first
shared, not when it was last edited. In practice the rule was "whoever shared it
first wins" — the opposite of what was intended, and of what I told you.

**A computer with the wrong date won every argument for ever.** A laptop whose
clock is set years ahead looks newer than everything, so every later change made
anywhere else would have been silently overridden. Dates from the future are now
pulled back to real time, and every machine measures against the web site's clock
rather than its own.

**Clearing the stock history could leave stock figures behind.** Stock is now
always recalculated from the movements behind it, on every machine.

## What is honestly guaranteed about conflicts

If a change is shared before someone else edits the same thing, the later edit
wins — that is the ordinary case and it is now correct.

If two people edit the same record between the same two syncs, nothing recorded
which came first, so which one wins is not meaningful. What is guaranteed is
that **every machine ends up agreeing**, the answer is one of the two real
values and never a mixture, and **the version that lost is written down** where
you can read it — Settings → Records changed in both places.

I previously described this as "the newer one wins" without qualification. That
was wrong, and it is now stated accurately in the program itself.

## What is checked before a release is published

- **25 figures** worked out by hand
- **79 operations** — buying, delivering, invoicing, collecting, year-end close
- **A day in the shop** — a full day's work, and all 24 screens opened
- **52 sharing checks** — the real web server and the real desktop program made
  to talk over HTTP
- **26 awkward situations** — deleting what another machine is using, a third
  computer joining a business already running, three machines working at once,
  and a machine whose clock says 2099
- The installer is installed on a clean Windows machine and must open a window,
  sign in, draw the dashboard and read back the item master — **16 self-checks**

Your bookers' orders still come through to the desktop with **Share now**, and
the web site still has not updated since 16 August — Vercel refuses every
deployment with *Not authorized*. That remains an account problem, not a fault
in the software.
