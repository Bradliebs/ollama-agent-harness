; Ollama Agent Harness - NSIS Installer Script
; Requires NSIS 3.x - https://nsis.sourceforge.io/
;
; Build steps:
;   1. npm ci && npm run build        (from repo root)
;   2. makensis installer/harness-installer.nsi
;
; The installer bundles dist/, ui/, start.bat, package.json,
; and node_modules/ (production only). The user must have
; Node.js >= 18 and Ollama installed separately.

!include "MUI2.nsh"
!include "FileFunc.nsh"

; --- Metadata ---
Name "Ollama Agent Harness"
OutFile "..\Harness-Setup.exe"
InstallDir "$LOCALAPPDATA\OllamaAgentHarness"
InstallDirRegKey HKCU "Software\OllamaAgentHarness" "InstallDir"
RequestExecutionLevel user

; --- Version info ---
VIProductVersion "0.3.19.0"
VIAddVersionKey "ProductName" "Ollama Agent Harness"
VIAddVersionKey "FileDescription" "Local-first agentic AI system"
VIAddVersionKey "FileVersion" "0.3.19"
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
  nsExec::ExecToStack 'cmd /c node --version'
  Pop $0
  Pop $1
  StrCmp $0 "0" NodeOK
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "Node.js was not found.$\n$\nYou need Node.js 18+ to run the Harness.$\nDownload it from https://nodejs.org/$\n$\nClick OK to continue anyway, or Cancel to abort." \
      IDOK NodeOK
    Abort
  NodeOK:

  ; Check for Ollama
  nsExec::ExecToStack 'cmd /c ollama --version'
  Pop $0
  Pop $1
  StrCmp $0 "0" OllamaOK
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Ollama was not found.$\n$\nYou need Ollama to run AI models locally.$\nDownload it from https://ollama.com/$\n$\nYou can install it after setup completes."
  OllamaOK:
FunctionEnd

; --- Install section ---
Section "Install"
  SetOutPath "$INSTDIR\dist"

  ; Core application files
  File /r "..\dist\*.*"
  SetOutPath "$INSTDIR\ui"
  File /r "..\ui\*.*"
  SetOutPath "$INSTDIR"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\start.bat"
  File "..\start-background.bat"
  File "..\stop-server.bat"
  File "..\START-HERE.md"
  File "..\README.md"

  ; Install production dependencies
  SetOutPath "$INSTDIR"
  nsExec::ExecToLog 'cmd /c cd /d "$INSTDIR" && npm ci --omit=dev'

  ; Create launcher script
  FileOpen $0 "$INSTDIR\launch.bat" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'cd /d "$INSTDIR"$\r$\n'
  FileWrite $0 'set PORT=4000$\r$\n'
  FileWrite $0 'start "" http://127.0.0.1:4000$\r$\n'
  FileWrite $0 'node dist/web/server.js$\r$\n'
  FileClose $0

  ; Desktop shortcut
  CreateShortcut "$DESKTOP\Ollama Agent Harness.lnk" \
    "$INSTDIR\launch.bat" "" "$INSTDIR\launch.bat" 0

  ; Start menu
  CreateDirectory "$SMPROGRAMS\Ollama Agent Harness"
  CreateShortcut "$SMPROGRAMS\Ollama Agent Harness\Ollama Agent Harness.lnk" \
    "$INSTDIR\launch.bat"
  CreateShortcut "$SMPROGRAMS\Ollama Agent Harness\Uninstall.lnk" \
    "$INSTDIR\uninstall.exe"

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
    "DisplayVersion" "0.3.19"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "NoRepair" 1

  ; Calculate installed size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness" \
    "EstimatedSize" $0
SectionEnd

; --- Uninstall section ---
Section "Uninstall"
  ; Remove files
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\ui"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\start.bat"
  Delete "$INSTDIR\start-background.bat"
  Delete "$INSTDIR\stop-server.bat"
  Delete "$INSTDIR\START-HERE.md"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\launch.bat"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\Ollama Agent Harness.lnk"
  Delete "$SMPROGRAMS\Ollama Agent Harness\Ollama Agent Harness.lnk"
  Delete "$SMPROGRAMS\Ollama Agent Harness\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Ollama Agent Harness"

  ; Remove registry
  DeleteRegKey HKCU "Software\OllamaAgentHarness"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OllamaAgentHarness"
SectionEnd
