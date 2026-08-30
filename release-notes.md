The prompt demanding a password on start-up is gone, at the owner's request.

Signing in goes straight to the dashboard as it did before. The password can
still be changed whenever you want, from **Company Profile → Change password**.

Nothing else about sign-in changed: accounts, roles and the login screen work
exactly as they did.

## Also in this version

The web site is finally deploying again after a fortnight stuck on 16 August
code. Two faults had to be fixed to get it there, both mine:

**The site crashed on every request.** The read-only-folder fallback written for
the Windows program runs while the code is being loaded, and a hosted server has
no home directory to create one in. With a database configured it no longer goes
looking for a folder at all. A test now reproduces a hosted server — read-only
filesystem, no home directory — so this cannot come back.

**Sharing could not run on the hosted database.** Inserts have `RETURNING id`
appended so the caller learns the new row's number, but the three sharing tables
are keyed by entity and uid and have no `id` column, so every insert into them
was refused.

Full two-way sharing is now live and was proved against the real site: a fresh
office computer joined, sent 90 records, received all 8 field bookings with
their shop names and phone numbers, and a second sync moved nothing and
duplicated nothing.

## Why the web site was stuck

Not the software. Vercel refuses a deployment whose **commit author** is not a
member of the project's team, and a Hobby plan cannot have members. The commits
were authored under one address while the project belongs to another account,
so every push since 16 August was rejected before the build began — which is
why they showed no log, no error, and a build time of zero. Commits are now
authored under the account that owns the project, and deployments take about
ten seconds.

## Worth knowing

The password the software ships with, **admin123**, still opens any installation
where it has not been changed — including the live web site, which is reachable
from the public repository. Changing it is now entirely up to whoever runs the
business.
