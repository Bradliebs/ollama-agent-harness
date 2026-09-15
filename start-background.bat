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

node scripts\check-runtime.js --launch-mode
if errorlevel 1 goto BUILD_FAIL
if not exist src\web\server.ts goto BUILD_OK
echo   Building from source...
call npm run build
if errorlevel 1 goto BUILD_FAIL
echo   [OK] Build complete
:BUILD_OK

echo.
echo   Starting server in background. Its browser opens when ready.
if not defined PORT set PORT=4300
if not defined HARNESS_PROJECT_DIR set "HARNESS_PROJECT_DIR=%USERPROFILE%\apex-workspace"
if not defined HARNESS_PROFILE set "HARNESS_PROFILE=assistant"
node scripts\background-server.js start
if errorlevel 1 goto LAUNCH_FAIL
echo.
echo   The server selects another port if the preferred port is occupied.
echo.
echo   To stop the server later, run:
echo     stop-server.bat
echo.
echo   ============================================
echo.
pause
exit /b 0

:BUILD_FAIL
echo   [X] Build failed.
pause
exit /b 1

:LAUNCH_FAIL
echo   [X] Background launch failed. See the error above.
pause
exit /b 1
