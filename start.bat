@echo off
title Ollama Agent Harness
cd /d "%~dp0"
setlocal

echo.
echo   ============================================
echo   Ollama Agent Harness - Setup and Launch
echo   ============================================
echo.

:: Step 1: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
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
)
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v found

:: Step 2: Check npm
where npm >nul 2>nul
if errorlevel 1 (
	echo   [X] npm was not found. Reinstall Node.js from https://nodejs.org/
	pause
	exit /b 1
)

:: Step 3: Check Ollama
where ollama >nul 2>nul
if errorlevel 1 (
	echo   [!!] Ollama was not found in PATH.
	echo.
	echo   To fix this:
	echo   1. Go to https://ollama.com/
	echo   2. Click Download and install it
	echo   3. After installing, open a new terminal and run: ollama pull llama3.2
	echo   4. Then double-click start.bat again
	echo.
	echo   You can skip this if Ollama is already running elsewhere.
	echo.
	set /p SKIP_OLLAMA="Press Enter to continue anyway, or type Q to quit: "
	if /i "!SKIP_OLLAMA!"=="Q" exit /b 1
) else (
	for /f "tokens=*" %%v in ('ollama --version 2^>nul') do echo   [OK] Ollama found: %%v
)

:: Step 4: Install dependencies
if not exist node_modules\ (
	echo.
	echo   Installing dependencies (first time only, may take a minute)...
	call npm ci
	if errorlevel 1 (
		echo.
		echo   [X] Dependency install failed. Check your internet connection and try again.
		pause
		exit /b 1
	)
	echo   [OK] Dependencies installed
)

:: Step 5: Build
if not exist dist\web\server.js (
	echo.
	echo   Building from source (first time only)...
	call npm run build
	if errorlevel 1 (
		echo   [X] Build failed.
		pause
		exit /b 1
	)
	echo   [OK] Build complete
)

:: Step 6: Launch
echo.
echo   Starting Ollama Agent Harness...
echo   Your browser should open automatically.
echo   If not, go to: http://127.0.0.1:4000
echo.
echo   Press Ctrl+C to stop the server.
echo   ============================================
echo.

if "%PORT%"=="" set PORT=4000

:: Auto-open browser after a short delay
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:%PORT%"

call npm run serve
pause
