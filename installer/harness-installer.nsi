; Ollama Agent Harness - NSIS Installer Script
; Requires NSIS 3.x - https://nsis.sourceforge.io/
;
; Build steps:
;   1. npm ci && npm run build        (from repo root)
;   2. makensis installer/harness-installer.nsi
;
; The installer bundles dist/, ui/, start.bat, package.json,
; and node_modules/ (production only). The user must have
; Node.js >= 22.13 and Ollama installed separately for local inference.

!include "MUI2.nsh"
!include "FileFunc.nsh"

; --- Metadata ---
Name "Ollama Agent Harness"
OutFile "..\Harness-Setup.exe"
InstallDir "$LOCALAPPDATA\OllamaAgentHarness"
InstallDirRegKey HKCU "Software\OllamaAgentHarness" "InstallDir"
RequestExecutionLevel user

; --- Version info ---
VIProductVersion "0.6.5.0"
VIAddVersionKey "ProductName" "Ollama Agent Harness"
VIAddVersionKey "FileDescription" "Local-first agentic AI system"
VIAddVersionKey "FileVersion" "0.6.5"
VIAddVersionKey "LegalCopyright" "MIT License"

; --- UI ---
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --- Pre-install checks ---
Function .onInit
  ; Check for Node.js
  nsExec::ExecToStack 'node -e "const [major,minor]=process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)"'
  Pop $0
  Pop $1
  StrCmp $0 "0" NodeOK
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Node.js 22.13 or newer is required.$\n$\nInstall Node.js 24 LTS from https://nodejs.org/ and run setup again." /SD IDOK
    Abort
  NodeOK:

  ; Check for Ollama
  nsExec::ExecToStack 'cmd /c ollama --version'
  Pop $0
  Pop $1
  StrCmp $0 "0" OllamaOK
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Ollama was not found.$\n$\nYou need Ollama to run AI models locally.$\nDownload it from https://ollama.com/$\n$\nYou can install it after setup completes." /SD IDOK
  OllamaOK:
FunctionEnd

!macro PrepareMaintenance prefix
  InitPluginsDir
  File /oname=$PLUGINSDIR\harness-maintenance.js "..\scripts\background-server.js"
  nsExec::ExecToStack 'node "$PLUGINSDIR\harness-maintenance.js" begin-maintenance "$INSTDIR" "$PLUGINSDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" ${prefix}MaintenanceOK
    MessageBox MB_OK|MB_ICONSTOP "Cannot safely change this installation.$\n$1$\nStop foreground servers manually before retrying." /SD IDOK
    SetErrorLevel 2
    Abort
  ${prefix}MaintenanceOK:
!macroend

!macro CompleteMaintenance prefix
  nsExec::ExecToStack 'node "$PLUGINSDIR\harness-maintenance.js" end-maintenance "$INSTDIR" "$PLUGINSDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" ${prefix}MaintenanceComplete
    MessageBox MB_OK|MB_ICONSTOP "Maintenance ownership could not be released.$\n$1" /SD IDOK
    SetErrorLevel 2
    Abort
  ${prefix}MaintenanceComplete:
!macroend

; --- Install section ---
Section "Install"
  !insertmacro PrepareMaintenance Install
  SetOutPath "$INSTDIR\dist"

  ; Core application files
  File /r "..\dist\*.*"
  SetOutPath "$INSTDIR\ui"
  File /r "..\ui\*.*"
  SetOutPath "$INSTDIR"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\release-provenance.json"
  File "..\start.bat"
  File "..\start-background.bat"
  File "..\stop-server.bat"
  File "..\start-tray.bat"
  File "..\START-HERE.md"
  File "..\README.md"

  ; System tray client (PowerShell)
  SetOutPath "$INSTDIR\scripts"
  File "..\scripts\tray.ps1"
  File "..\scripts\check-runtime.js"
  File "..\scripts\background-server.js"
  SetOutPath "$INSTDIR"

  ; Install production dependencies
  SetOutPath "$INSTDIR"
  nsExec::ExecToLog 'cmd /c cd /d "$INSTDIR" && npm ci --omit=dev'
  Pop $0
  StrCmp $0 "0" DependenciesOK
    MessageBox MB_OK|MB_ICONSTOP "Dependency installation failed. Check your network connection and rerun setup." /SD IDOK
    Abort
  DependenciesOK:

  ; Create launcher script
  FileOpen $0 "$INSTDIR\launch.bat" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'cd /d "$INSTDIR"$\r$\n'
  FileWrite $0 'node scripts\check-runtime.js$\r$\n'
  FileWrite $0 'if errorlevel 1 exit /b 1$\r$\n'
  FileWrite $0 'if not defined PORT set PORT=4300$\r$\n'
  FileWrite $0 'if not defined HARNESS_PROJECT_DIR set "HARNESS_PROJECT_DIR=%USERPROFILE%\apex-workspace"$\r$\n'
  FileWrite $0 'node dist/web/server.js$\r$\n'
  FileClose $0

  ; Desktop shortcut
  CreateShortcut "$DESKTOP\Ollama Agent Harness.lnk" \
    "$INSTDIR\launch.bat" "" "$INSTDIR\launch.bat" 0

  ; Start menu
  CreateDirectory "$SMPROGRAMS\Ollama Agent Harness"
  CreateShortcut "$SMPROGRAMS\Ollama Agent Harness\Ollama Agent Harness.lnk" \
    "$INSTDIR\launch.bat"
  CreateShortcut "$SMPROGRAMS\Ollama Agent Harness\Harness Tray.lnk" \
    "$INSTDIR\start-tray.bat" "" "$INSTDIR\start-tray.bat" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\Ollama Agent Harness\Uninstall.lnk" \
    "$INSTDIR\uninstall.exe"

  ; Auto-launch tray on login (places shortcut in user's Startup folder)
  CreateShortcut "$SMSTARTUP\Ollama Agent Harness Tray.lnk" \
    "$INSTDIR\start-tray.bat" "" "$INSTDIR\start-tray.bat" 0 SW_SHOWMINIMIZED

  ; Registry and uninstaller
  WriteRegStr HKCU "Software\OllamaAgentHarness" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "DisplayName" "Ollama Agent Harness"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "Publisher" "Ollama Agent Harness"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "DisplayVersion" "0.6.5"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "NoRepair" 1

  ; Calculate installed size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "EstimatedSize" $0
  !insertmacro CompleteMaintenance Install
SectionEnd

; --- Uninstall section ---
Section "Uninstall"
  !insertmacro PrepareMaintenance Uninstall
  ; Remove files
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\ui"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\release-provenance.json"
  Delete "$INSTDIR\start.bat"
  Delete "$INSTDIR\start-background.bat"
  Delete "$INSTDIR\stop-server.bat"
  Delete "$INSTDIR\start-tray.bat"
  Delete "$INSTDIR\START-HERE.md"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\launch.bat"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\scripts\tray.ps1"
  Delete "$INSTDIR\scripts\check-runtime.js"
  Delete "$INSTDIR\scripts\background-server.js"
  RMDir "$INSTDIR\scripts"
  RMDir "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\Ollama Agent Harness.lnk"
  Delete "$SMPROGRAMS\Ollama Agent Harness\Ollama Agent Harness.lnk"
  Delete "$SMPROGRAMS\Ollama Agent Harness\Harness Tray.lnk"
  Delete "$SMPROGRAMS\Ollama Agent Harness\Uninstall.lnk"
  Delete "$SMSTARTUP\Ollama Agent Harness Tray.lnk"
  RMDir "$SMPROGRAMS\Ollama Agent Harness"

  ; Remove registry
  DeleteRegKey HKCU "Software\OllamaAgentHarness"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness"
  !insertmacro CompleteMaintenance Uninstall
SectionEnd
