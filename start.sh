#!/usr/bin/env bash
# Opens Usman Traders in its own desktop window.
cd "$(dirname "$0")" || exit 1
exec python3 desktop.py
