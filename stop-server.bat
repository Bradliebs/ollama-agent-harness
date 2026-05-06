@echo off
title Ollama Agent Harness - Stop Server
cd /d "%~dp0"

if not exist .harness\server.pid goto NO_PID

set /p SERVER_PID=<.harness\server.pid
echo Stopping server (PID %SERVER_PID%)...
taskkill /PID %SERVER_PID% /F >nul 2>nul
if errorlevel 1 (
    echo Server was not running.
) else (
    echo Server stopped.
)
del .harness\server.pid >nul 2>nul
goto END

:NO_PID
echo No server PID file found. Trying to find node on port 4300...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4300.*LISTEN"') do (
    echo Killing PID %%p
    taskkill /PID %%p /F >nul 2>nul
)
echo Done.

:END
pause
