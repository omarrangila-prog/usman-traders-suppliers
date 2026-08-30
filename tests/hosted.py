#!/usr/bin/env python3
"""The conditions a hosted server actually runs under.

A serverless host gives the program a read-only filesystem and no home
directory. Anything that goes looking for somewhere to write while the module
is being imported takes the whole site down with it - and does so on every
request, not just once. That happened, so it is checked here.

    python3 tests/hosted.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  <- {detail}"))
    if not ok:
        fails.append(label)


def run(code, **overrides):
    env = dict(os.environ)
    env.pop("UT_DB", None)
    env.update(overrides)
    return subprocess.run([sys.executable, "-c", code],
                          capture_output=True, text=True, env=env, cwd=HERE)


NOWHERE = "/proc/nonexistent-readonly"      # exists as a name, cannot be written

print("\n== a host with no writable home ==")
r = run("import db; print(db.DB_PATH)", HOME=NOWHERE,
        DATABASE_URL="postgresql://u:p@example.invalid/db")
check("db imports with a database URL and nowhere to write",
      r.returncode == 0, r.stderr.strip()[-200:])
check("and does not claim a file in a folder it cannot create",
      "/proc" not in r.stdout, r.stdout.strip())

r = run("import db, app; print('ok')", HOME=NOWHERE,
        DATABASE_URL="postgresql://u:p@example.invalid/db")
check("the whole application imports", r.returncode == 0, r.stderr.strip()[-200:])

r = run("import sys; sys.path.insert(0, 'api'); import index; print('ok')", HOME=NOWHERE,
        DATABASE_URL="postgresql://u:p@example.invalid/db")
check("the hosted entry point imports", r.returncode == 0, r.stderr.strip()[-300:])

print("\n== and still works normally on a computer ==")
r = run("import db; print(db.DB_PATH)")
check("a plain run still keeps its file beside the program",
      r.returncode == 0 and r.stdout.strip().endswith("usmantraders.db"),
      r.stdout.strip() or r.stderr.strip()[-200:])

print("\n" + "=" * 60)
print("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILURE(S): " + ", ".join(fails))
sys.exit(1 if fails else 0)
