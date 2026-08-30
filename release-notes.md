A check over the whole thing, and two more faults fixed.

## The password it ships with

Every copy of this program has been installed knowing **admin123**, and that
password is printed in the instructions. Until someone changed it, anyone who
could reach the machine was an administrator with the run of the books.

The program now refuses to show anything until a real password is chosen. The
prompt appears on the first sign-in, has no cancel and no way around it, and
will not accept the old password. Once set it never asks again — and staff
accounts, whose passwords were chosen by a person, are never nagged.

## The red warning that meant nothing

The web site showed **"Cloud check failed"** in the corner, permanently. It was
checking Appwrite — a service this software stopped storing anything in long
ago, and whose project has since been paused for inactivity. Your data has been
in the cloud database the whole time.

So the shop was being shown a red alarm about something neither true nor
actionable. The check is gone, along with the code behind it, and the corner now
says where the data actually is: **Saved in the cloud** on the web site,
**Saved on this computer** on the desktop.

## One I caused, and the tests caught

Removing that Appwrite check also removed the sharing endpoints, which sat next
to it in the same file. Bookings would have stopped coming through entirely. The
sharing tests failed immediately, which is what they are for. Restored, and
every suite passes again.

## What was checked

| | |
| --- | --- |
| Figures worked out by hand | 26 |
| Operations | 81 |
| A day in the shop, all 24 screens | 48 |
| The password it ships with | 8 |
| Sharing between desktop and cloud | 54 |
| Awkward situations | 30 |
| Python web server, with and without the login screen | all passing |
| The installed program on a clean Windows machine | 16 |

Every page the web site serves was requested and answers properly, and the
offline booking form still caches all 64 items for a phone with no signal.

## Still outstanding, and not fixable from here

**Your web site has not updated since 16 August.** Vercel refuses every
deployment with *Not authorized* — no build log, no error. Bookings still reach
the desktop through **Share now**, but invoices raised at the office cannot
travel out to the web site until that is sorted.

**The repository is private**, so these download links ask for a GitHub login.
Send your client the .exe directly, or make the repository public.
