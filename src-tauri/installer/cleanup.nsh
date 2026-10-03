; Invoked after running-app checks but BEFORE deleting the app or uninstall entry.
Function un.EnvDockCleanData
  ${If} $UpdateMode = 1
    Return
  ${EndIf}
  ; Exact /PURGE consent was parsed in un.onInit; /S alone preserves data.
  ${If} $DeleteAppDataCheckboxState <> 1
    Return
  ${EndIf}
  IfSilent envdock_purge 0
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$(ENV_PURGE_CONFIRM)" /SD IDNO IDYES envdock_purge
    SetErrorLevel 1
    Quit
  envdock_purge:
    InitPluginsDir
    File /oname=$PLUGINSDIR\envdock-uninstall-data.ps1 "${ENVDOCK_INSTALLER_DIR}\..\..\scripts\uninstall-data.ps1"
    nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\envdock-uninstall-data.ps1" -Purge'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "$(ENV_PURGE_FAILED)"
      DetailPrint "$1"
      MessageBox MB_OK|MB_ICONSTOP "$(ENV_PURGE_FAILED)" /SD IDOK
      SetErrorLevel 5
      Quit
    ${EndIf}
FunctionEnd
