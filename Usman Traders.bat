@echo off
title Usman Traders ^& Suppliers
cd /d "%~dp0"
python desktop.py
if errorlevel 1 (
  echo.
  echo Could not start. Make sure Python 3 is installed from python.org
  echo and that "Add Python to PATH" was ticked during installation.
  pause
)
