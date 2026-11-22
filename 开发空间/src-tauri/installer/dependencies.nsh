; Runtime preparation must finish before uninstalling an existing application.
; All script output is shown in the installation details; no credentials are logged.
Function EnvDockEnsureDependencies
  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\envdock-ensure-webview2.ps1" "${ENVDOCK_INSTALLER_DIR}\..\..\scripts\ensure-webview2.ps1"
  StrCpy $1 "zh-CN"
  ${If} $LANGUAGE == 1033
    StrCpy $1 "en-US"
  ${EndIf}
  envdock_dependencies_retry:
    DetailPrint "$(ENV_DEPS_PREPARE)"
    ; The helper has bounded download/process waits. Do not time out nsExec based
    ; on output inactivity while a legitimate Microsoft installer is running.
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\envdock-ensure-webview2.ps1" -WorkDirectory "$PLUGINSDIR" -Language "$1"'
    Pop $0
    ${If} $0 == "0"
      DetailPrint "$(ENV_DEPS_READY)"
      Pop $1
      Pop $0
      Return
    ${EndIf}
    DetailPrint "$(ENV_DEPS_FAILED) [$0]"
    ${If} $0 == "3010"
      ${IfNot} ${Silent}
      ${AndIf} $PassiveMode != 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(ENV_DEPS_REBOOT)" /SD IDOK
      ${EndIf}
      SetErrorLevel 3010
      ${If} ${Silent}
      ${OrIf} $PassiveMode = 1
        Quit
      ${EndIf}
      Abort "$(ENV_DEPS_REBOOT)"
    ${EndIf}
    ${If} $0 == "1460"
      ${IfNot} ${Silent}
      ${AndIf} $PassiveMode != 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(ENV_DEPS_TIMEOUT)" /SD IDOK
      ${EndIf}
      SetErrorLevel 1460
      ${If} ${Silent}
      ${OrIf} $PassiveMode = 1
        Quit
      ${EndIf}
      Abort "$(ENV_DEPS_TIMEOUT)"
    ${EndIf}
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      SetErrorLevel 1603
      Quit
    ${EndIf}
    MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "$(ENV_DEPS_ACTION)" /SD IDCANCEL IDYES envdock_dependencies_retry IDNO envdock_dependencies_manual
    Goto envdock_dependencies_abort
  envdock_dependencies_manual:
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
    MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "$(ENV_DEPS_MANUAL)" /SD IDCANCEL IDRETRY envdock_dependencies_retry
  envdock_dependencies_abort:
    SetErrorLevel 1603
    Abort "$(ENV_DEPS_FAILED)"
FunctionEnd
