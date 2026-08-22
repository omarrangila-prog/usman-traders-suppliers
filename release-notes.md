A real Windows desktop program, not a web page in disguise.

The previous build was a Python web server that borrowed a Chrome window. It
needed a browser to be installed and to behave, it showed a console, and it was
a server the whole time. This is an actual desktop application: Electron draws
the window, the program holds your data itself, and the two talk directly.
There is no port, no address to type and no server. It works with no internet
because there is nothing for it to reach.

## Which file do I want?

| File | Use it when |
| --- | --- |
| **UsmanTraders-Setup-2.0.0.exe** | Normal use. Installs the program with a Start-menu and desktop shortcut. |
| **UsmanTraders-Portable-2.0.0.exe** | You cannot install software on the machine. Runs as-is. |

**Windows will warn you the first time.** Click **More info → Run anyway**.
That happens because the program is not code-signed — signing needs a paid
yearly certificate — not because anything is wrong with it.

## Your data

One file on that computer. **Help → About** shows the exact path, and the chip
at the bottom left of the sidebar opens the folder.

Use **File → Save a backup** regularly. That single file is your whole business
record.

## What was checked before this was published

Nothing here is assumed to work. Every one of these ran on a clean Windows
machine, and the release is not published if any of them fails:

- **25 figures** worked out by hand — stock, cost of goods, receivables,
  payables, depreciation, profit, and a balance sheet that balances — compared
  against what the program reports.
- **79 operations** — buying, delivering, invoicing, collecting, editing,
  deleting, year-end close, roles and passwords.
- The installer is **installed the way a customer would install it**, and the
  installed program then has to open a real window, load its interface, sign
  in, draw the dashboard and read back the item master.
- The portable program has to do the same **from a folder it is not allowed to
  write to**, which is what running it straight out of a downloaded zip does.

## Also in this version

- Invoices, stock and the double-entry books are unchanged in behaviour — the
  same rules, checked against the same figures as before.
- The sidebar no longer reports a failed cloud check on a program that has no
  cloud. It says where your data is saved, and opens the folder when clicked.
- Excel exports and backups now ask you where to save, instead of dropping
  files into a downloads folder.
- Run the program with `--self-check` to have it prove itself on a machine and
  report what passed.

The web version at
[usman-traders-suppliers-dho8.vercel.app](https://usman-traders-suppliers-dho8.vercel.app)
is unchanged and still serves the office and the field-booking phones.
