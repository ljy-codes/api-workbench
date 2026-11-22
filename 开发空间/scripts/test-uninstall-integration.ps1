<#
.SYNOPSIS
Headless NSIS -> nsExec -> Windows PowerShell 5.1 synthetic uninstall tests.
.DESCRIPTION
Requires Windows PowerShell 5.1 and the already installed Tauri NSIS compiler.
No registry access, real installation, UI automation, or real-profile cleanup.
Only this run's unique repo .tmp tree is written/deleted. TEMP/TMP for child
processes also point into that tree (including NSIS plugin extraction).

Copies the production options.nsh and cleanup.nsh byte-for-byte. In a COPY of
uninstall-data.ps1, replaces ONLY the two special-folder expressions inside
Get-UninstallDataRoots with validated, case-local synthetic paths. The rest of
the production script is text-identical, including its CLI and exit behavior.
The mini installer only writes a real NSIS uninstaller. Its uninstall section
calls the production cleanup callback before deleting fake app/registration
marker FILES. No production registry key is read or written.

This exercises real silent argument parsing, embedding, nsExec, cleanup and
abort ordering. It does not test the full product installer/template, actual
registration, real profile resolution, running-app checks, elevation, visible
confirmation UI, branding, or the complete Windows uninstall experience.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$temporary = Join-Path $project '.tmp'
$work = Join-Path $temporary ('uninstall-integration-' + [guid]::NewGuid().ToString('N'))
$script:passed = 0
$script:failed = 0
$script:retainWork = $false
$sourcePaths = @{
    Cleanup = Join-Path $project 'src-tauri\installer\cleanup.nsh'
    Options = Join-Path $project 'src-tauri\installer\options.nsh'
    Script = Join-Path $project 'scripts\uninstall-data.ps1'
}
$compiler = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tauri\NSIS\makensis.exe'

function Assert-Integration($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-IntegrationAttributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-IntegrationAncestors([string]$Path) {
    $chain = New-Object 'System.Collections.Generic.List[string]'
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $chain.Insert(0, $current)
        $current = [IO.Path]::GetDirectoryName($current)
    }
    foreach ($part in $chain) {
        $attributes = Get-IntegrationAttributes $part
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Fixture ancestor is a reparse point; refused.'
        }
    }
}

function Assert-IntegrationTarget([string]$Path, [switch]$AllowLeafLink) {
    $full = [IO.Path]::GetFullPath($Path)
    Assert-Integration ($full -ceq $Path) 'Noncanonical fixture path refused.'
    Assert-Integration ($full.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase)) 'Target is outside repo .tmp.'
    Assert-Integration ($full -eq $work -or $full.StartsWith($work + '\', [StringComparison]::OrdinalIgnoreCase)) 'Target is outside this run.'
    Assert-IntegrationAncestors ([IO.Path]::GetDirectoryName($full))
    if (-not $AllowLeafLink) { Assert-IntegrationAncestors $full }
    return $full
}

function Write-IntegrationText([string]$Path, [string]$Text) {
    $full = Assert-IntegrationTarget $Path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))
    # BOM is required for Windows PowerShell 5.1 when repo/profile paths are non-ASCII.
    [IO.File]::WriteAllText($full, $Text, (New-Object Text.UTF8Encoding $true))
}

function Remove-IntegrationTree([string]$Path) {
    $full = Assert-IntegrationTarget $Path -AllowLeafLink
    $attributes = Get-IntegrationAttributes $full
    if ($null -eq $attributes) { return }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint)) {
        if (($attributes -band [IO.FileAttributes]::Directory)) { [IO.Directory]::Delete($full, $false) }
        else { [IO.File]::Delete($full) }
    } elseif (($attributes -band [IO.FileAttributes]::Directory)) {
        foreach ($child in [IO.Directory]::GetFileSystemEntries($full)) { Remove-IntegrationTree $child }
        [IO.Directory]::Delete($full, $false)
    } else {
        [IO.File]::SetAttributes($full, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($full)
    }
}

function Get-IntegrationSnapshot([string]$Path) {
    [void](Assert-IntegrationTarget $Path -AllowLeafLink)
    $attributes = Get-IntegrationAttributes $Path
    if ($null -eq $attributes) { return '<absent>' }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint)) { return '<reparse-point>' }
    if (($attributes -band [IO.FileAttributes]::Directory)) {
        $rows = foreach ($child in ([IO.Directory]::GetFileSystemEntries($Path) | Sort-Object)) {
            [IO.Path]::GetFileName($child) + ':' + (Get-IntegrationSnapshot $child)
        }
        return ($rows -join '|')
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function ConvertTo-IntegrationNsisString([string]$Value) {
    return $Value.Replace('$', '$$').Replace('"', '$\"')
}

function Invoke-IntegrationProcess([string]$Executable, [string]$Arguments, [string]$CaseRoot) {
    [void](Assert-IntegrationTarget $CaseRoot)
    if (-not $Executable.Equals($compiler, [StringComparison]::OrdinalIgnoreCase)) {
        [void](Assert-IntegrationTarget $Executable)
    }
    $temp = Assert-IntegrationTarget (Join-Path $CaseRoot 'process-temp')
    [void][IO.Directory]::CreateDirectory($temp)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $CaseRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['TEMP'] = $temp
    $start.EnvironmentVariables['TMP'] = $temp
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            # Do not clean a tree that might still be used by a child nsExec process.
            $script:retainWork = $true
            $process.Kill()
            $process.WaitForExit()
            throw 'Fixture process timeout; tree retained because child-process state is unknown.'
        }
        return @{ ExitCode = $process.ExitCode; Output = $stdout.Result + $stderr.Result }
    } finally { $process.Dispose() }
}

function New-IntegrationScriptCopy([string]$Destination, [string]$LocalRoot, [string]$RoamingRoot) {
    [void](Assert-IntegrationTarget $LocalRoot)
    [void](Assert-IntegrationTarget $RoamingRoot)
    $text = $script:productionScript
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    Assert-Integration ($errors.Count -eq 0) 'Production script parse error.'
    $resolver = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-UninstallDataRoots'
    }, $true))
    Assert-Integration ($resolver.Count -eq 1) 'Expected exactly one production root resolver.'
    $extent = $resolver[0].Extent
    $before = $text.Substring(0, $extent.StartOffset)
    $after = $text.Substring($extent.EndOffset)
    $originalFunction = $extent.Text
    $localExpression = '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)'
    $roamingExpression = '[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)'
    foreach ($expression in @($localExpression, $roamingExpression)) {
        Assert-Integration ([regex]::Matches($originalFunction, [regex]::Escape($expression)).Count -eq 1) 'Root resolver changed; refuse unsafe substitution.'
    }
    $localLiteral = "'" + $LocalRoot.Replace("'", "''") + "'"
    $roamingLiteral = "'" + $RoamingRoot.Replace("'", "''") + "'"
    $functionCopy = $originalFunction.Replace($localExpression, $localLiteral).Replace($roamingExpression, $roamingLiteral)
    $copy = $before + $functionCopy + $after
    $roundTrip = $before + $functionCopy.Replace($localLiteral, $localExpression).Replace($roamingLiteral, $roamingExpression) + $after
    Assert-Integration ($roundTrip -ceq $text) 'Fixture changed more than special-folder resolution.'
    Write-IntegrationText $Destination $copy
    Assert-Integration ([IO.File]::ReadAllText($Destination) -ceq $copy) 'Fixture script copy mismatch.'
    # Definitions only; production script itself is never executed or dot-sourced.
    . $Destination
    $resolved = Get-UninstallDataRoots
    Assert-Integration ($resolved.LocalApplicationData -ceq $LocalRoot -and $resolved.ApplicationData -ceq $RoamingRoot) 'Fixture resolver did not return isolated roots.'
}

function New-IntegrationFixture($Case) {
    $caseRoot = Assert-IntegrationTarget (Join-Path $work ([guid]::NewGuid().ToString('N')))
    $includeDirectory = Join-Path $caseRoot 'src-tauri\installer'
    $local = Join-Path $caseRoot 'syntheticfixturelocal'
    $roaming = Join-Path $caseRoot 'syntheticfixtureroaming'
    $targets = @((Join-Path $local 'ApiWorkbench'), (Join-Path $local 'local.apiworkbench.desktop'),
        (Join-Path $roaming 'local.apiworkbench.desktop'))
    foreach ($directory in @($includeDirectory, $local, $roaming)) {
        [void][IO.Directory]::CreateDirectory((Assert-IntegrationTarget $directory))
    }
    foreach ($key in @('Cleanup', 'Options')) {
        $destination = Assert-IntegrationTarget (Join-Path $includeDirectory ([IO.Path]::GetFileName($sourcePaths[$key])))
        [IO.File]::WriteAllBytes($destination, $script:sourceBytes[$key])
        Assert-Integration ((Get-FileHash -LiteralPath $destination).Hash -eq $script:sourceHashes[$key]) 'NSIS include was not copied identically.'
    }
    New-IntegrationScriptCopy (Join-Path $caseRoot 'scripts\uninstall-data.ps1') $local $roaming
    if ($Case.Name -ne 'missingdirs-success') {
        foreach ($relative in @('ApiWorkbench\app.db', 'ApiWorkbench\app.db-wal',
            'ApiWorkbench\backups\nested\history.sqlite', 'local.apiworkbench.desktop\framework.cache\nested\cache.bin')) {
            Write-IntegrationText (Join-Path $local $relative) 'synthetic-local-data'
        }
        Write-IntegrationText (Join-Path $targets[2] 'framework.cache\nested\cache.bin') 'synthetic-roaming-data'
    }
    $fakeApp = Join-Path $caseRoot 'fake-install\fakeapp.exe'
    $marker = Join-Path $caseRoot 'fake-install\uninstall-marker.txt'
    $outside = Join-Path $caseRoot 'outside'
    Write-IntegrationText $fakeApp 'not-a-real-executable'
    Write-IntegrationText $marker 'not-a-registry-entry'
    Write-IntegrationText (Join-Path $outside 'sentinel.txt') 'outside-sentinel'
    foreach ($relative in @('Yaak\sentinel', 'ApiWorkbenchData\sentinel', 'manual-exports\sentinel',
        'sharedWebView2\sentinel', '.envdock-migration-sentinel\backup\app.db')) {
        Write-IntegrationText (Join-Path $local $relative) 'outside-owned-roots'
    }
    $lockedFile = Join-Path $targets[2] 'locked.db'
    if ($Case.Name -eq 'lockedfile-failure') { Write-IntegrationText $lockedFile 'synthetic-lock-content' }
    if ($Case.Name -eq 'junction-failure') {
        $junction = Assert-IntegrationTarget (Join-Path $targets[2] 'framework.cache\outside-link')
        [void](Assert-IntegrationTarget $outside)
        [void](New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop)
    }
    $installer = Join-Path $caseRoot 'fixture-builder.exe'
    $uninstaller = Join-Path $caseRoot 'fixture-uninstall.exe'
    $parserState = Join-Path $caseRoot 'parser-state.txt'
    $returned = Join-Path $caseRoot 'cleanup-returned.txt'
    $nsi = Join-Path $caseRoot 'fixture.nsi'
    $source = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
AutoCloseWindow true
Name "EnvDock synthetic cleanup fixture"
OutFile "@@INSTALLER@@"
!include FileFunc.nsh
!include LogicLib.nsh
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
Var UpdateMode
Var PassiveMode
Var DeleteAppDataCheckboxState
!define ENVDOCK_INSTALLER_DIR "@@INCLUDES@@"
LangString ENV_PURGE_CONFIRM 1033 "Synthetic fixture cleanup confirmation"
LangString ENV_PURGE_FAILED 1033 "Synthetic fixture cleanup failed"
!include "${ENVDOCK_INSTALLER_DIR}\options.nsh"
!insertmacro EnvDockOptionParser "un."
!include "${ENVDOCK_INSTALLER_DIR}\cleanup.nsh"
Function un.onInit
  Call un.EnvDockParseOptions
  FileOpen $0 "@@PARSER@@" w
  FileWrite $0 "$UpdateMode,$PassiveMode,$DeleteAppDataCheckboxState"
  FileClose $0
FunctionEnd
Section
  WriteUninstaller "@@UNINSTALLER@@"
SectionEnd
Section "Uninstall"
  Call un.EnvDockCleanData
  FileOpen $0 "@@RETURNED@@" w
  FileWrite $0 "cleanup-returned"
  FileClose $0
  Delete "@@FAKEAPP@@"
  Delete "@@MARKER@@"
SectionEnd
'@
    $replacements = @{
        '@@INSTALLER@@' = $installer; '@@INCLUDES@@' = $includeDirectory
        '@@UNINSTALLER@@' = $uninstaller; '@@PARSER@@' = $parserState
        '@@RETURNED@@' = $returned; '@@FAKEAPP@@' = $fakeApp; '@@MARKER@@' = $marker
    }
    foreach ($key in $replacements.Keys) { $source = $source.Replace($key, (ConvertTo-IntegrationNsisString $replacements[$key])) }
    Write-IntegrationText $nsi $source
    $compiled = Invoke-IntegrationProcess $compiler ('/INPUTCHARSET UTF8 /NOCONFIG /V2 "' + $nsi + '"') $caseRoot
    Assert-Integration ($compiled.ExitCode -eq 0) ("NSIS fixture compilation failed: " + $compiled.Output)
    $built = Invoke-IntegrationProcess $installer '/S' $caseRoot
    Assert-Integration ($built.ExitCode -eq 0 -and [IO.File]::Exists($uninstaller)) 'Could not write fixture uninstaller.'
    return @{
        CaseRoot = $caseRoot; Local = $local; Roaming = $roaming; Targets = $targets
        FakeApp = $fakeApp; Marker = $marker; Outside = $outside; LockedFile = $lockedFile
        Uninstaller = $uninstaller; ParserState = $parserState; Returned = $returned
    }
}

function Test-IntegrationCase($Case) {
    $fixture = New-IntegrationFixture $Case
    $beforeLocal = Get-IntegrationSnapshot $fixture.Local
    $beforeRoaming = Get-IntegrationSnapshot $fixture.Roaming
    $beforeOutside = Get-IntegrationSnapshot $fixture.Outside
    $handle = $null
    try {
        if ($Case.Name -eq 'lockedfile-failure') {
            $handle = [IO.File]::Open($fixture.LockedFile, 'Open', 'ReadWrite', 'None')
        }
        # _?= is the FINAL argument, unquoted as required by NSIS. It avoids the
        # normal asynchronous self-copy/relaunch and makes this exit code authoritative.
        $result = Invoke-IntegrationProcess $fixture.Uninstaller ($Case.Arguments + ' _?=' + $fixture.CaseRoot) $fixture.CaseRoot
    } finally { if ($null -ne $handle) { $handle.Dispose() } }
    Assert-Integration ($result.ExitCode -eq $Case.ExitCode) ("Expected exit {0}, got {1}." -f $Case.ExitCode, $result.ExitCode)
    Assert-Integration ([IO.File]::ReadAllText($fixture.ParserState) -ceq $Case.Parser) 'Production option parser state mismatch.'
    if ($Case.ExitCode -eq 0) {
        Assert-Integration (-not [IO.File]::Exists($fixture.FakeApp)) 'Successful callback did not reach fake app removal.'
        Assert-Integration (-not [IO.File]::Exists($fixture.Marker)) 'Successful callback did not reach fake registration removal.'
        Assert-Integration ([IO.File]::Exists($fixture.Returned)) 'Successful cleanup did not return.'
    } else {
        Assert-Integration ([IO.File]::ReadAllText($fixture.FakeApp) -ceq 'not-a-real-executable') 'Failure removed or changed the fake app.'
        Assert-Integration ([IO.File]::ReadAllText($fixture.Marker) -ceq 'not-a-registry-entry') 'Failure removed or changed the fake registration marker.'
        Assert-Integration (-not [IO.File]::Exists($fixture.Returned)) 'Failure fell through the cleanup callback.'
    }
    if ($Case.Purged) {
        foreach ($target in $fixture.Targets) { Assert-Integration ($null -eq (Get-IntegrationAttributes $target)) 'App-owned root remains after purge.' }
        foreach ($relative in @('Yaak\sentinel', 'ApiWorkbenchData\sentinel', 'manual-exports\sentinel',
            'sharedWebView2\sentinel', '.envdock-migration-sentinel\backup\app.db')) {
            Assert-Integration ([IO.File]::ReadAllText((Join-Path $fixture.Local $relative)) -ceq 'outside-owned-roots') 'Unrelated sibling data changed.'
        }
    } else {
        Assert-Integration ((Get-IntegrationSnapshot $fixture.Local) -ceq $beforeLocal) 'Preserve/failure changed local data.'
        Assert-Integration ((Get-IntegrationSnapshot $fixture.Roaming) -ceq $beforeRoaming) 'Preserve/failure changed roaming data.'
    }
    Assert-Integration ((Get-IntegrationSnapshot $fixture.Outside) -ceq $beforeOutside) 'Outside junction sentinel changed.'
}

Assert-Integration ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) 'Run with Windows PowerShell 5.1.'
Assert-Integration ([IO.File]::Exists($compiler)) 'Local Tauri NSIS compiler is missing; no download/install attempted.'
Assert-IntegrationAncestors $temporary
$script:sourceHashes = @{}
$script:sourceBytes = @{}
foreach ($key in $sourcePaths.Keys) {
    $script:sourceHashes[$key] = (Get-FileHash -LiteralPath $sourcePaths[$key]).Hash
    $script:sourceBytes[$key] = [IO.File]::ReadAllBytes($sourcePaths[$key])
}
$script:productionScript = [IO.File]::ReadAllText($sourcePaths.Script)
$cases = @(
    @{ Name = 'silent-default-preserve'; Arguments = '/S'; ExitCode = 0; Parser = '0,0,0'; Purged = $false }
    @{ Name = 'purge-success'; Arguments = '/S /PURGE'; ExitCode = 0; Parser = '0,0,1'; Purged = $true }
    @{ Name = 'purge-equals-zero-preserve'; Arguments = '/S /PURGE=0'; ExitCode = 0; Parser = '0,0,0'; Purged = $false }
    @{ Name = 'update-purge-preserve'; Arguments = '/S /UPDATE /PURGE'; ExitCode = 0; Parser = '1,0,1'; Purged = $false }
    @{ Name = 'lockedfile-failure'; Arguments = '/S /PURGE'; ExitCode = 5; Parser = '0,0,1'; Purged = $false }
    @{ Name = 'junction-failure'; Arguments = '/S /PURGE'; ExitCode = 5; Parser = '0,0,1'; Purged = $false }
    @{ Name = 'missingdirs-success'; Arguments = '/S /PURGE'; ExitCode = 0; Parser = '0,0,1'; Purged = $true }
)
[void][IO.Directory]::CreateDirectory((Assert-IntegrationTarget $work))
try {
    foreach ($case in $cases) {
        try {
            Test-IntegrationCase $case
            $script:passed++
            Write-Host ("PASS {0}: NSIS exit={1}, parser={2}" -f $case.Name, $case.ExitCode, $case.Parser)
        } catch {
            $script:failed++
            Write-Host ("FAIL {0}: {1}" -f $case.Name, $_)
            Write-Host $_.ScriptStackTrace
        }
        if ($script:retainWork) { break }
    }
} finally {
    foreach ($key in $sourcePaths.Keys) {
        if ((Get-FileHash -LiteralPath $sourcePaths[$key]).Hash -ne $script:sourceHashes[$key]) {
            $script:failed++
            Write-Host "FAIL production input changed during the run: $key (not restored)"
        }
    }
    if ($script:retainWork) { Write-Host "Fixture retained for manual inspection: $work" }
    else { Remove-IntegrationTree $work }
}
Write-Host ("Windows PowerShell {0}; NSIS integration passed={1}; failed={2}; planned={3}" -f
    $PSVersionTable.PSVersion, $script:passed, $script:failed, $cases.Count)
if ($script:failed -gt 0 -or $script:passed -ne $cases.Count) { exit 1 }
exit 0
