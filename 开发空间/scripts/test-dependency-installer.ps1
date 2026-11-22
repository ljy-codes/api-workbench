# Synthetic NSIS fixtures only: no network, registry writes or real installation.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root ('.tmp\dependency-nsis-' + [guid]::NewGuid().ToString('N'))
$compiler = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tauri\NSIS\makensis.exe'
if (-not [IO.File]::Exists($compiler)) { throw 'Build the installer once to prepare the Tauri NSIS compiler.' }
[void][IO.Directory]::CreateDirectory($work)
$template = [IO.File]::ReadAllText((Join-Path $root 'src-tauri\installer\envdock.nsi'))
$start = $template.IndexOf('Section WebView2')
$end = $template.IndexOf('Section Install', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Production dependency section missing.' }
$productionSection = $template.Substring($start, $end - $start)
$cases = @(
    @{ Name = 'existing-or-auto-installed'; Result = 0; Update = 0; Passive = 0; Pending = 0; Exit = 0 }
    @{ Name = 'upgrade-success-before-removal'; Result = 0; Update = 0; Passive = 0; Pending = 1; Exit = 0 }
    @{ Name = 'update-still-checks-dependencies'; Result = 1; Update = 1; Passive = 0; Pending = 0; Exit = 1603 }
    @{ Name = 'failure-retains-previous-app'; Result = 1; Update = 0; Passive = 0; Pending = 1; Exit = 1603 }
    @{ Name = 'passive-failure-no-dialog'; Result = 1; Update = 0; Passive = 1; Pending = 1; Exit = 1603 }
    @{ Name = 'reboot-retains-previous-app'; Result = 3010; Update = 0; Passive = 0; Pending = 1; Exit = 3010 }
    @{ Name = 'timeout-retains-previous-app'; Result = 1460; Update = 0; Passive = 0; Pending = 1; Exit = 1460 }
    @{ Name = 'passive-reboot-exits'; Result = 3010; Update = 0; Passive = 1; Pending = 1; Exit = 3010 }
    @{ Name = 'passive-timeout-exits'; Result = 1460; Update = 0; Passive = 1; Pending = 1; Exit = 1460 }
)
$passed = 0
foreach ($case in $cases) {
    $dir = Join-Path $work $case.Name
    $include = Join-Path $dir 'src-tauri\installer'
    [void][IO.Directory]::CreateDirectory($include)
    [void][IO.Directory]::CreateDirectory((Join-Path $dir 'scripts'))
    foreach ($file in @('dependencies.nsh','messages.nsh')) {
        Copy-Item -LiteralPath (Join-Path $root "src-tauri\installer\$file") -Destination $include
    }
    $helper = Join-Path $dir 'scripts\ensure-webview2.ps1'
    $observed = Join-Path $dir 'helper-observed.txt'
    $oldApp = Join-Path $dir 'old-app.fixture'
    $installed = Join-Path $dir 'new-app.fixture'
    $removed = Join-Path $dir 'old-removed.fixture'
    [IO.File]::WriteAllText($oldApp, 'previous-app-content')
    $ps = 'param([string]$WorkDirectory,[string]$Language)' + "`r`n" +
        "[IO.File]::WriteAllText('" + $observed.Replace("'","''") + "', 'called'); " +
        "Write-Output 'Synthetic dependency preparation'; exit $($case.Result)"
    [IO.File]::WriteAllText($helper, $ps, (New-Object Text.UTF8Encoding $true))
    $exe = Join-Path $dir 'fixture.exe'
    $source = @'
Unicode true
RequestExecutionLevel user
SilentInstall normal
AutoCloseWindow true
Name "EnvDock synthetic dependency fixture"
OutFile "@@EXE@@"
!include MUI2.nsh
!include LogicLib.nsh
Var PassiveMode
Var UpdateMode
Var EnvDockPendingUninstall
Var EnvDockPreviousVersionComparison
Var EnvDockPreviousWixKey
!define VERSION "1.0.0"
!define ENVDOCK_INSTALLER_DIR "@@INCLUDE@@"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include "${ENVDOCK_INSTALLER_DIR}\messages.nsh"
!include "${ENVDOCK_INSTALLER_DIR}\dependencies.nsh"
Function .onInit
  StrCpy $PassiveMode @@PASSIVE@@
  StrCpy $UpdateMode @@UPDATE@@
  StrCpy $EnvDockPendingUninstall @@PENDING@@
  StrCpy $EnvDockPreviousVersionComparison 1
FunctionEnd
Function EnvDockUninstallPrevious
  IfFileExists "@@OBSERVED@@" +3 0
    SetErrorLevel 77
    Quit
  Delete "@@OLD@@"
  FileOpen $0 "@@REMOVED@@" w
  FileWrite $0 "removed-after-dependency"
  FileClose $0
FunctionEnd
@@PRODUCTION@@
Section Install
  FileOpen $0 "@@INSTALLED@@" w
  FileWrite $0 "payload-installed"
  FileClose $0
SectionEnd
'@
    $replacements = @{
        '@@EXE@@'=$exe; '@@INCLUDE@@'=$include; '@@PASSIVE@@'="$($case.Passive)"
        '@@UPDATE@@'="$($case.Update)"; '@@PENDING@@'="$($case.Pending)"
        '@@OBSERVED@@'=$observed; '@@OLD@@'=$oldApp; '@@REMOVED@@'=$removed; '@@INSTALLED@@'=$installed
    }
    foreach ($key in $replacements.Keys) {
        $source = $source.Replace($key, $replacements[$key].Replace('$','$$').Replace('"','$\"'))
    }
    $source = $source.Replace('@@PRODUCTION@@', $productionSection)
    $nsi = Join-Path $dir 'fixture.nsi'
    [IO.File]::WriteAllText($nsi, $source, (New-Object Text.UTF8Encoding $true))
    & $compiler /INPUTCHARSET UTF8 /NOCONFIG /V1 $nsi
    if ($LASTEXITCODE) { throw "Fixture compilation failed: $($case.Name)" }
    $arguments = if ($case.Passive -eq 1) { '/P' } else { '/S' }
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(45000)) { $process.Kill(); throw "Fixture timed out: $($case.Name)" }
    if ($process.ExitCode -ne $case.Exit) { throw "$($case.Name): expected $($case.Exit), got $($process.ExitCode)" }
    if (-not [IO.File]::Exists($observed)) { throw 'Dependency helper was skipped.' }
    if ($case.Exit -eq 0) {
        if (-not [IO.File]::Exists($installed)) { throw 'Successful dependency check did not continue installation.' }
        if ($case.Pending -eq 1 -and ([IO.File]::Exists($oldApp) -or -not [IO.File]::Exists($removed))) {
            throw 'Deferred upgrade did not execute after dependency preparation.'
        }
    } else {
        if (-not [IO.File]::Exists($oldApp) -or [IO.File]::ReadAllText($oldApp) -ne 'previous-app-content') { throw 'Dependency failure changed previous app.' }
        if ([IO.File]::Exists($installed) -or [IO.File]::Exists($removed)) { throw 'Dependency failure fell through to install/uninstall.' }
    }
    $process.Dispose()
    $passed++
    Write-Host "PASS $($case.Name)"
}
Write-Host "NSIS dependency integration: $passed/$($cases.Count) passed. Synthetic fixtures: $work"
