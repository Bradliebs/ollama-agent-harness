@echo off
REM Compatibility shim. The assistant ("Jarvis") features are now the default
REM for start.bat via HARNESS_PROFILE=assistant. This script remains so existing
REM shortcuts keep working: it forces the explicit offline-Whisper voice path,
REM then hands off to the single unified launcher.

set "HARNESS_PROFILE=assistant"
if not defined HARNESS_WHISPER_PYTHON set "HARNESS_WHISPER_PYTHON=python"

cd /d "%~dp0"
call start.bat %*
