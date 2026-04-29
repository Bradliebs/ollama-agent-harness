@echo off
title Ollama Agent Harness
cd /d "%~dp0"
set PORT=4000
npm run serve
pause
