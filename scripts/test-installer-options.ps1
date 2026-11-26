$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root ('.tmp\nsis-options-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$include = Join-Path $root 'src-tauri\installer\options.nsh'
$exe = Join-Path $work 'options.exe'
$result = Join-Path $work 'result.txt'
$source = @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "$exe"
!include LogicLib.nsh
Var PassiveMode
Var UpdateMode
Var DeleteAppDataCheckboxState
!include "$include"
!insertmacro EnvDockOptionParser ""
Section
  Call EnvDockParseOptions
  FileOpen `$0 "$result" w
  FileWrite `$0 "`$PassiveMode,`$UpdateMode,`$DeleteAppDataCheckboxState"
  FileClose `$0
SectionEnd
"@
$nsi = Join-Path $work 'options.nsi'
$source | Set-Content -LiteralPath $nsi -Encoding utf8
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
& $nsis /INPUTCHARSET UTF8 /V2 $nsi
if ($LASTEXITCODE) { throw 'Option fixture compilation failed.' }
$cases = @(
    @('/S', '0,0,0'),
    @('/S /PURGE', '0,0,1'),
    @('/S /PURGE=0', '0,0,0'),
    @('/S /PURGE-NOT', '0,0,0'),
    @('/S /PURGE=false', '0,0,0'),
    @('/S /purge', '0,0,0'),
    @('/S /P', '1,0,0'),
    @('/S /UPDATE /PURGE', '0,1,1'),
    @('/S /P /UPDATE', '1,1,0'),
    @('/S /UPDATE-NOT', '0,0,0'),
    @('/S /D=C:\sample\PURGE', '0,0,0'),
    @('/S "/PURGE"', '0,0,1')
)
foreach ($case in $cases) {
    if (Test-Path -LiteralPath $result) { Remove-Item -LiteralPath $result }
    $p = Start-Process -FilePath $exe -ArgumentList $case[0] -WindowStyle Hidden -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw "Fixture failed: $($case[0])" }
    $actual = Get-Content -LiteralPath $result -Raw
    if ($actual -ne $case[1]) { throw "$($case[0]): wanted $($case[1]), got $actual" }
    Write-Output "PASS $($case[0]) -> $actual"
}
Write-Output "$($cases.Count) NSIS argument cases passed. Evidence: $work"
