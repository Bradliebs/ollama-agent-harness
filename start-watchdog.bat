@echo off
title Ollama Agent Harness (Watchdog)
cd /d "%~dp0"

echo.
echo   ============================================
echo   Ollama Agent Harness - Watchdog Mode
echo   ============================================
echo   Server will auto-restart on crash.
echo   Press Ctrl+C to stop permanently.
echo   ============================================
echo.

:: Build first
call npm run build
if errorlevel 1 goto BUILD_FAIL

:: Never kill whatever holds port 4300: it may be an unrelated app. The
:: server picks another free port and prints it if 4300 is taken.

:: Clean stale Telegram lock
del /f /q ".harness\telegram-poller.lock.json" >nul 2>nul

set PORT=4300
set NO_OPEN=1
if not defined HARNESS_PROFILE set "HARNESS_PROFILE=assistant"

:RESTART
echo.
echo   [%date% %time%] Starting server...
node dist/web/server.js
echo.
echo   [%date% %time%] Server exited (code %errorlevel%). Restarting in 3 seconds...
timeout /t 3 /nobreak >nul

:: Clean Telegram lock between restarts
del /f /q ".harness\telegram-poller.lock.json" >nul 2>nul

goto RESTART

:BUILD_FAIL
echo   [X] Build failed.
pause
exit /b 1
