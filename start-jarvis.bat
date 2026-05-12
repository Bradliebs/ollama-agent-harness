@echo off
REM Start the harness with Jarvis voice (offline whisper) enabled.
REM Double-click this from Explorer or run from any terminal.

set HARNESS_WHISPER_PYTHON=python
set HARNESS_AMBIENT_ENABLED=1

cd /d %~dp0
call npm run ui
