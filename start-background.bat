@echo off
title Ollama Agent Harness (Background)
cd /d "%~dp0"

echo.
echo   ============================================
echo   Ollama Agent Harness - Background Mode
echo   ============================================
echo.
echo   The server will keep running even after you
echo   close this window.
echo.

:: Build first
echo   Building from source...
call npm run build
if errorlevel 1 goto BUILD_FAIL
echo   [OK] Build complete

:: Start in background using PowerShell Start-Process
echo.
echo   Checking for an existing Harness server on port 4300...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4300.*LISTEN"') do (
	echo   Stopping stale server PID %%p
	taskkill /PID %%p /F >nul 2>nul
)
echo.
echo   Starting server in background on port 4300...
set PORT=4300
set NO_OPEN=1
if not defined HARNESS_PROFILE set "HARNESS_PROFILE=assistant"
powershell -Command "Start-Process -FilePath 'node' -ArgumentList 'dist/web/server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id } | Out-File -FilePath '%~dp0.harness\server.pid' -Encoding ascii"
echo.

:: Read the PID
set /p SERVER_PID=<.harness\server.pid
echo   [OK] Server started in background (PID %SERVER_PID%)
echo.
echo   Open in your browser:  http://127.0.0.1:4300
echo.
echo   To stop the server later, run:
echo     stop-server.bat
echo   Or:
echo     taskkill /PID %SERVER_PID% /F
echo.
echo   ============================================
echo.
pause
exit /b 0

:BUILD_FAIL
echo   [X] Build failed.
pause
exit /b 1
