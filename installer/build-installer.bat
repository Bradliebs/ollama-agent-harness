@echo off
title Build Harness Installer
cd /d "%~dp0.."

echo.
echo   ============================================
echo   Building Ollama Agent Harness Installer
echo   ============================================
echo.

:: Step 1: Check NSIS
makensis /VERSION >nul 2>nul
if errorlevel 1 (
    echo   [X] NSIS not found.
    echo.
    echo   Install NSIS from https://nsis.sourceforge.io/
    echo   Then add it to your PATH.
    pause
    exit /b 1
)
echo   [OK] NSIS found

:: Step 2: Clean build
echo.
echo   Building from source...
call npm ci
if errorlevel 1 goto FAIL
call npm run build
if errorlevel 1 goto FAIL
echo   [OK] Build complete

:: Step 3: Run NSIS
echo.
echo   Creating installer...
makensis installer\harness-installer.nsi
if errorlevel 1 goto FAIL
echo   [OK] Installer created: Harness-Setup.exe
echo.
pause
exit /b 0

:FAIL
echo   [X] Build failed.
pause
exit /b 1
