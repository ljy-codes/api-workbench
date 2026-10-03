; CommandLineToArgvW + StrCmpS: destructive consent must be a standalone token.
; GetOptions performs prefix matching (/PURGE=0 would otherwise be accepted).
!macro EnvDockOptionParser Prefix
Function ${Prefix}EnvDockParseOptions
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $PassiveMode 0
  StrCpy $UpdateMode 0
  StrCpy $DeleteAppDataCheckboxState 0
  StrCpy $0 $CMDLINE
  System::Call 'shell32::CommandLineToArgvW(w r0, *i .r1) p.r2'
  ${If} $2 = 0
    SetErrorLevel 5
    Quit
  ${EndIf}
  StrCpy $3 $2
  envdock_args_loop:
    ${If} $1 = 0
      Goto envdock_args_done
    ${EndIf}
    System::Call '*$3(p .r4)'
    System::Call '*$4(&w${NSIS_MAX_STRLEN} .r5)'
    StrCmpS $5 "/P" 0 +2
      StrCpy $PassiveMode 1
    StrCmpS $5 "/UPDATE" 0 +2
      StrCpy $UpdateMode 1
    StrCmpS $5 "/PURGE" 0 +2
      StrCpy $DeleteAppDataCheckboxState 1
    IntOp $3 $3 + ${NSIS_PTR_SIZE}
    IntOp $1 $1 - 1
    Goto envdock_args_loop
  envdock_args_done:
  System::Call 'kernel32::LocalFree(p r2)'
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
