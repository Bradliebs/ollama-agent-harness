@echo off
setlocal enabledelayedexpansion
title Ollama Agent Harness
cd /d "%~dp0"

REM Unified launcher: run the assistant profile by default so voice, ambient
REM awareness and chat channels are on without a separate start-jarvis.bat.
REM Override by setting HARNESS_PROFILE or the individual HARNESS_* flags before
REM launching.
if not defined HARNESS_PROFILE set "HARNESS_PROFILE=assistant"

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
if errorlevel 1 (
  echo   npm ci failed, trying npm install...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] Dependency install failed. Common fixes:
    echo       - Check your internet connection
    echo       - Delete node_modules folder and try again
    echo.
    pause
    exit /b 1
  )
)
echo   [OK] Dependencies installed
goto DEPS_OK

:DEPS_OK

:: Step 4: Build
echo.
echo   Building from source...
call npm run build
if errorlevel 1 (
  echo.
  echo   [X] Build failed. Try these steps:
  echo       1. Delete node_modules folder
  echo       2. Run: npm install
  echo       3. Run: npm run build
  echo       If it still fails, check the error above for details.
  echo.
  pause
  exit /b 1
)
echo   [OK] Build complete

:: Step 5: Workspace — agent files go here, NOT in the harness repo
echo.
set "WORKSPACE_CONFIG=%~dp0.harness-workspace"
if defined HARNESS_PROJECT_DIR (
  echo   Workspace: %HARNESS_PROJECT_DIR%
  goto WORKSPACE_OK
)
:: Load saved workspace from last run (PowerShell read strips any UTF-8 BOM
:: written by older versions of this script)
set "SAVED_WORKSPACE="
if exist "%WORKSPACE_CONFIG%" (
  for /f "usebackq tokens=* delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%WORKSPACE_CONFIG%').Trim()"`) do set "SAVED_WORKSPACE=%%i"
)
if defined SAVED_WORKSPACE (
  echo   [OK] Using saved workspace: !SAVED_WORKSPACE!
  set "WORKSPACE=!SAVED_WORKSPACE!"
) else (
  echo   Where should the agent work? ^(its files, memory, outputs go here^)
  echo   Press Enter for default: %USERPROFILE%\apex-workspace
  echo.
  set /p "WORKSPACE=  Workspace folder: "
  if "!WORKSPACE!"=="" set "WORKSPACE=%USERPROFILE%\apex-workspace"
)
if not exist "!WORKSPACE!" mkdir "!WORKSPACE!"
set "HARNESS_PROJECT_DIR=!WORKSPACE!"
:: Save for next time (plain cmd redirect = no BOM)
>"%WORKSPACE_CONFIG%" echo !WORKSPACE!
echo   [OK] Workspace: !HARNESS_PROJECT_DIR!

:WORKSPACE_OK

:: Shared auth token for the local memory bank (ccmem). Generated once and
:: persisted under the workspace so every restart reuses the same value; both
:: the ccmem sidecar and the harness inherit it via the environment set here.
:: This makes the supported launch path authenticated by default. Memory stays
:: best-effort: if any step is skipped, ccmem simply runs unauthenticated and
:: the harness still works, just without same-host access protection.
set "CCMEM_DIR=!HARNESS_PROJECT_DIR!\.harness\ccmem"
if not exist "!CCMEM_DIR!" mkdir "!CCMEM_DIR!" >nul 2>nul
set "CCMEM_TOKEN_FILE=!CCMEM_DIR!\token"
if not exist "!CCMEM_TOKEN_FILE!" (
  for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"`) do >"!CCMEM_TOKEN_FILE!" echo %%t
)
if exist "!CCMEM_TOKEN_FILE!" set /p HARNESS_CCMEM_TOKEN=<"!CCMEM_TOKEN_FILE!"

:: Step 6: Launch ccmem (Concept Cells semantic memory — built-in, optional)
python --version >nul 2>nul
if errorlevel 1 (
  echo   [--] Python not found - semantic memory disabled ^(install Python to enable^)
  goto CCMEM_DONE
)

:: Verify ccmem's Python deps are importable before launching
python -c "import uvicorn, fastapi, sentence_transformers" >nul 2>nul
if errorlevel 1 (
  echo   [--] ccmem Python deps missing - semantic memory disabled
  echo        To enable: pip install -r ccmem\requirements.txt
  goto CCMEM_DONE
)

:: If port 8765 is held, verify it's actually ccmem responding to /health
netstat -ano | findstr ":8765.*LISTEN" >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    echo   [OK] ccmem already running on port 8765
  ) else (
    echo   [!!] Port 8765 is in use by something else - semantic memory disabled
  )
  goto CCMEM_DONE
)

echo   Starting ccmem ^(semantic memory^) on port 8765...
start "ccmem" /min cmd /c "cd /d "%~dp0" && python -m uvicorn ccmem.service:app --host 127.0.0.1 --port 8765"

:: Poll /health for up to 30s before declaring ready (single PowerShell process
:: avoids spawning 30 sub-shells; uvicorn typically binds in ~2s)
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(30); while((Get-Date) -lt $d) { try { Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch {} ; Start-Sleep -Milliseconds 500 } ; exit 1"
if not errorlevel 1 (
  echo   [OK] ccmem ready on port 8765
  echo        Note: first memory call downloads ~80 MB embedding model ^(one-time^)
) else (
  echo   [!!] ccmem did not respond within 30s - semantic memory may be unavailable
  echo        Check the ccmem window for errors
)

:CCMEM_DONE

:: Step 7: Launch
echo.
echo   Closing any Harness servers that are already running...
:: Kill every prior Harness server regardless of which port it grabbed.
:: Matches only "dist\web\server.js" node processes, so editors, Ollama and
:: other node apps are never touched.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist.web.server' } | ForEach-Object { Write-Host ('   Stopping Harness server PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
:: Backstop: free the target port (4300) even if a non-Harness process holds it.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4300.*LISTEN"') do (
	echo   Freeing port 4300 held by PID %%p
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
