@echo off
:: Ollama Agent Harness - launch the system tray client (hidden window)
::
:: The tray polls http://127.0.0.1:%HARNESS_PORT% (default 4300) and exposes
:: a context menu for kill-switch, autonomy, and server control. Safe to run
:: even if the server isn't started yet — the tray will show 'gray' until
:: the server comes up.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\tray.ps1"
