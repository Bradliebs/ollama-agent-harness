@echo off
title Ollama Agent Harness
cd /d "%~dp0"

echo.
echo   ============================================
echo   Ollama Agent Harness - Setup and Launch
echo   ============================================
echo.

:: Step 1: Check Node.js
node --version >nul 2>nul
if errorlevel 1 goto NO_NODE
goto HAS_NODE

:NO_NODE
echo   [X] Node.js was not found.
echo.
echo   To fix this:
echo   1. Go to https://nodejs.org/
echo   2. Download the LTS version (the big green button)
echo   3. Run the installer (click Next through everything)
echo   4. Close this window and double-click start.bat again
echo.
pause
exit /b 1

:HAS_NODE
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v found

:: Step 2: Check Ollama
ollama --version >nul 2>nul
if errorlevel 1 goto NO_OLLAMA
goto HAS_OLLAMA

:NO_OLLAMA
echo   [!!] Ollama was not found.
echo.
echo   You need Ollama to run AI models locally.
echo   1. Go to https://ollama.com/
echo   2. Click Download and install it
echo   3. After installing, run: ollama pull llama3.2
echo.
echo   Continuing anyway (Ollama may be running elsewhere)...
echo.

:HAS_OLLAMA

:: Step 3: Install dependencies
if exist node_modules goto DEPS_OK
echo.
echo   Installing dependencies (first time only, may take a minute)...
call npm ci
if errorlevel 1 goto DEPS_FAIL
echo   [OK] Dependencies installed
goto DEPS_OK

:DEPS_FAIL
echo   [X] Dependency install failed.
pause
exit /b 1

:DEPS_OK

:: Step 4: Build
echo.
echo   Building from source...
call npm run build
if errorlevel 1 goto BUILD_FAIL
echo   [OK] Build complete
goto BUILD_OK

:BUILD_FAIL
echo   [X] Build failed.
pause
exit /b 1

:BUILD_OK

:: Step 5: Launch
echo.
echo   Checking for an existing Harness server on port 4000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000.*LISTEN"') do (
	echo   Stopping stale server PID %%p
	taskkill /PID %%p /F >nul 2>nul
)
echo.
echo   Starting Ollama Agent Harness...
echo   Your browser will open automatically.
echo   If not, go to: http://127.0.0.1:4000
echo.
echo   Press Ctrl+C to stop the server.
echo   ============================================
echo.

set PORT=4000
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:4000"
call npm run serve
pause
