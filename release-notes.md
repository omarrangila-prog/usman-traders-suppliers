The desktop program and the web site now share one set of books.

Until now they were two separate businesses that happened to look alike. A
booking your man took on his phone could not be seen at the office, and an
invoice raised at the office never reached the web site. They now exchange
changes whenever the desktop has a connection — and the desktop still works
with none, because it keeps its own copy and never waits on the network.

## How to switch it on

**Settings → Sharing with the cloud.** Put in your web address, the sign-in name
and password you use there, and press **Save**. After that, **Share now** — in
that panel, on the sidebar chip, or **Ctrl+R** — swaps changes both ways.

The sidebar chip tells you when you last shared.

## What was hard about it, and how it is handled

**Both sides already had the same 64 items.** Created separately, they would
have merged into 128. Every travelling row carries an id that is unique
everywhere, and the rows both sides create for themselves — the item master, the
vendor list, the chart of accounts — work theirs out from the item code, so both
machines arrive at the same id without ever having spoken. The first sync
recognises all 69 as shared and duplicates nothing.

**Deletions.** A row that is simply gone cannot be told from one that has not
arrived yet, so a deletion leaves a marker. Delete a customer here and it goes
there, and it does not come back on the next sync.

**The same record changed in both places.** The newer one wins, and the older is
kept — not thrown away. **Settings → Records changed in both places** shows both
versions so you can see exactly what happened.

**Both machines issuing ORD-0003.** Apart, neither can see the other's
numbering, so both reach for the same number. The arriving document is given a
free number instead of being refused or overwriting the other, and both machines
end up showing the same numbering.

**Stock.** Recalculated from the movement history after every merge, so the
figure on both sides always agrees with the ledger behind it.

## What was checked before this was published

The real Python web server and the real desktop program are made to talk to each
other over HTTP — nothing mocked — and must pass **46 checks**: no duplication,
work flowing both ways, a phone booking arriving and converting to an order, a
deletion staying deleted, a clash being logged rather than lost, both sides
ending with identical order numbers, stock agreeing, the books balancing on both
sides, and a settled pair going quiet instead of exchanging forever.

That runs alongside the 25 hand-computed figures and 79 operational checks, and
then the installer is installed on a clean Windows machine and the installed
program must open a window, sign in, draw the dashboard and read back your item
master. **16 self-checks.** A build that fails any of it is not published.

## One thing you need to know

**Your web site has not updated since 16 August.** Every deployment since then
has failed to build on Vercel — no build log, no error, nothing. That is an
account problem, not a fault in the software.

Until it updates, the web site has no sharing endpoint, and pressing Share now
will tell you so plainly rather than failing with a cryptic error. Nothing on
this computer is changed by the attempt.

Everything else in this version works with no internet, exactly as before.
