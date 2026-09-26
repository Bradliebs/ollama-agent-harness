@echo off
title Ollama Agent Harness - Stop Server
cd /d "%~dp0"

node scripts\background-server.js stop
set "STOP_RESULT=%ERRORLEVEL%"
if /I not "%~1"=="--no-pause" pause
exit /b %STOP_RESULT%
