@echo off
REM Start the harness with Jarvis voice (offline whisper) enabled.
REM Double-click this from Explorer or run from any terminal.

set HARNESS_WHISPER_PYTHON=python
set HARNESS_AMBIENT_ENABLED=1

cd /d %~dp0

REM Workspace isolation — reuse existing env var or prompt
if not defined HARNESS_PROJECT_DIR (
  if "%WORKSPACE%"=="" set "WORKSPACE=%USERPROFILE%\hermes-workspace"
  if not exist "%WORKSPACE%" mkdir "%WORKSPACE%"
  set "HARNESS_PROJECT_DIR=%WORKSPACE%"
)

call npm run ui
