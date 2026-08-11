#!/usr/bin/env python3
"""Usman Traders - desktop launcher.

Double-click this (or run `python3 desktop.py`) and the software opens in its
own window, with no browser address bar and nothing to type. It starts the
server on a free port, waits for it, opens the window, and shuts the server
down again when the window is closed.

Everything stays on this computer: the data sits in usmantraders.db beside this
file, so it works with no internet at all. Set DATABASE_URL first if you would
rather it used the shared cloud database.
"""

import atexit
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

BASE_DIR = (os.path.dirname(os.path.abspath(sys.executable))
            if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import app as application  # noqa: E402
import db  # noqa: E402

# Chromium-family browsers can open a plain window with no tabs or address bar,
# which is what makes this feel like a desktop program rather than a web page.
APP_BROWSERS = [
    "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
    "brave-browser", "microsoft-edge", "microsoft-edge-stable",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def free_port(preferred=8000):
    """Use the usual port if it is free, so bookmarks keep working."""
    for port in (preferred, 0):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return probe.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("No free port available.")


def wait_until_ready(port, seconds=30):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2).read()
            return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.25)
    return False


def find_browser():
    for candidate in APP_BROWSERS:
        found = shutil.which(candidate) or (candidate if os.path.exists(candidate) else None)
        if found:
            return found
    return None


def main():
    port = free_port()
    db.init().close()

    server = ThreadingHTTPServer(("127.0.0.1", port), application.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    atexit.register(server.shutdown)

    url = f"http://127.0.0.1:{port}/"
    print(f"  Usman Traders & Suppliers")
    print(f"  running at {url}")
    print(f"  data file  {db.DB_PATH}\n")

    if not wait_until_ready(port):
        raise SystemExit("The server did not start. Check the messages above.")

    if "--no-window" in sys.argv or os.environ.get("UT_NO_WINDOW"):
        print("  Running without a window. Press Ctrl+C to stop.\n")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    browser = find_browser()
    if not browser:
        import webbrowser
        webbrowser.open(url)
        print("  Opened in your default browser. Close this window to stop.\n")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    # A separate profile keeps the app window free of other tabs and extensions.
    profile = os.path.join(BASE_DIR, ".desktop-profile")
    started = time.time()
    window = subprocess.Popen([
        browser, f"--app={url}", f"--user-data-dir={profile}",
        "--window-size=1280,860", "--no-first-run", "--no-default-browser-check",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print("  Window open. Close it to shut the software down.\n")
    try:
        window.wait()
        # A window that dies at once did not really open - a missing profile,
        # a browser policy, an already-running instance. Shutting the server
        # down here would look to the user like the program simply failed.
        if time.time() - started < 3:
            import webbrowser
            print("  The app window would not open; using your default browser instead.\n")
            webbrowser.open(url)
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        window.terminate()
    finally:
        server.shutdown()
        print("  Stopped. Your data is saved.")


if __name__ == "__main__":
    main()
