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

:: Kill any stale process on port 4000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000.*LISTEN"') do (
    echo   Killing stale process PID %%p on port 4000
    taskkill /PID %%p /F >nul 2>nul
)

:: Clean stale Telegram lock
del /f /q ".harness\telegram-poller.lock.json" >nul 2>nul

set PORT=4000
set NO_OPEN=1

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
