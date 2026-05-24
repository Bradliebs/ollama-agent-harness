@echo off
setlocal enabledelayedexpansion
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

:: Step 5: Workspace — agent files go here, NOT in the harness repo
echo.
set "WORKSPACE_CONFIG=%~dp0.harness-workspace"
if defined HARNESS_PROJECT_DIR (
  echo   Workspace: %HARNESS_PROJECT_DIR%
  goto WORKSPACE_OK
)
:: Load saved workspace from last run
if exist "%WORKSPACE_CONFIG%" (
  set /p "SAVED_WORKSPACE=" < "%WORKSPACE_CONFIG%"
)
if defined SAVED_WORKSPACE (
  echo   [OK] Using saved workspace: %SAVED_WORKSPACE%
  set "WORKSPACE=%SAVED_WORKSPACE%"
) else (
  echo   Where should the agent work? (its files, memory, outputs go here)
  echo   Press Enter for default: %USERPROFILE%\hermes-workspace
  echo.
  set /p "WORKSPACE=  Workspace folder: "
  if "!WORKSPACE!"=="" set "WORKSPACE=%USERPROFILE%\hermes-workspace"
)
if not exist "!WORKSPACE!" mkdir "!WORKSPACE!"
set "HARNESS_PROJECT_DIR=!WORKSPACE!"
:: Save for next time
powershell -Command "Set-Content -Path '%WORKSPACE_CONFIG%' -Value '!WORKSPACE!' -NoNewline -Encoding UTF8"
echo   [OK] Workspace: !HARNESS_PROJECT_DIR!

:WORKSPACE_OK

:: Step 6: Launch cc_service (Concept Memory - MiniLM semantic memory)
echo.
echo   Starting cc_service (semantic memory)...
set "CCMEM_DIR=H:\MiniLM\cc_service"
if exist "%CCMEM_DIR%\service\main.py" (
  netstat -ano | findstr ":8765.*LISTEN" >nul 2>nul
  if errorlevel 1 (
    start "cc_service" /min cmd /c "cd /d "%CCMEM_DIR%" && uvicorn service.main:app --host 0.0.0.0 --port 8765"
    echo   [OK] cc_service starting on port 8765
  ) else (
    echo   [OK] cc_service already running on port 8765
  )
) else (
  echo   [--] cc_service not found at %CCMEM_DIR% - semantic memory disabled
)

:: Step 7: Launch
echo.
echo   Checking for an existing Harness server on port 4300...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4300.*LISTEN"') do (
	echo   Stopping stale server PID %%p
	taskkill /PID %%p /F >nul 2>nul
)
echo.
echo   Starting Ollama Agent Harness...
echo   Your browser will open automatically.
echo   If not, go to: http://127.0.0.1:4300
echo.
echo   Press Ctrl+C to stop the server.
echo   ============================================
echo.

set PORT=4300
call npm run serve
pause
