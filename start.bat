@echo off
title Ollama Agent Harness
cd /d "%~dp0"
setlocal

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js was not found. Install Node.js 20 or later, then run this file again.
	echo Download: https://nodejs.org/
	pause
	exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
	echo npm was not found. Reinstall Node.js 20 or later, then run this file again.
	pause
	exit /b 1
)

if not exist node_modules\ (
	echo Installing dependencies with npm ci...
	npm ci
	if errorlevel 1 (
		echo Dependency installation failed.
		pause
		exit /b 1
	)
)

if not exist dist\web\server.js (
	echo Compiled server was not found. Building from source...
	npm run build
	if errorlevel 1 (
		echo Build failed.
		pause
		exit /b 1
	)
)

if "%PORT%"=="" set PORT=4000
echo Starting Ollama Agent Harness on port %PORT%...
npm run serve
pause
