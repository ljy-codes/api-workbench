; GUI init runs before the reinstall page can uninstall an existing version.
; Silent installers skip GUI init, so check again before installing files.
!define ENVDOCK_INSTALLER_DIR "${__FILEDIR__}\installer"
!addplugindir "${ENVDOCK_INSTALLER_DIR}\plugins"
!define MUI_CUSTOMFUNCTION_GUIINIT EnvDockCheckInstalledVersion

Function EnvDockCheckInstalledVersion
  Push $0
  Push $1
  ; Tauri includes this file before its VERSION/UNINSTKEY/plugin definitions.
  ; Read our PE version instead of duplicating the release version in this file.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnvDock" "DisplayVersion"
  ${If} $0 != ""
    ${GetFileVersion} "$EXEPATH" $1
    ${VersionCompare} $1 $0 $1
    ${If} $1 == 2
      MessageBox MB_OK|MB_ICONSTOP "A newer EnvDock version ($0) is already installed. Downgrading is blocked to protect local data." /SD IDOK
      SetErrorLevel 1638
      Quit
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  IfSilent +2 0
    EnvDockTheme::Apply /NOUNLOAD
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call EnvDockCheckInstalledVersion
!macroend
