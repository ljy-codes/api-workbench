# Synthetic data only; no Pester or external dependencies. Run in Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$project = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path $project '.tmp'
$root = Join-Path $temporary ('uninstall-tests-' + [guid]::NewGuid().ToString('N'))
$implementation = Join-Path $PSScriptRoot 'uninstall-data.ps1'
$script:passed = 0
$script:failed = 0

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-TestAttributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

# Validate from drive down, BEFORE entering a possible junction.
function Assert-TestAncestors([string]$Path) {
    $chain = New-Object 'System.Collections.Generic.List[string]'
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $chain.Insert(0, $current)
        $current = [IO.Path]::GetDirectoryName($current)
    }
    foreach ($part in $chain) {
        $attributes = Get-TestAttributes $part
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Test ancestor is a reparse point; refused.'
        }
    }
}

function Assert-TestTarget([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $root -and -not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Test operation outside the unique repo .tmp fixture refused.'
    }
    Assert-TestAncestors ([IO.Path]::GetDirectoryName($full))
    return $full
}

# No recursive delete primitive. A junction is removed as a link, never traversed.
function Remove-TestTree([string]$Path) {
    $full = Assert-TestTarget $Path
    $attributes = Get-TestAttributes $full
    if ($null -eq $attributes) { return }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint)) {
        if (($attributes -band [IO.FileAttributes]::Directory)) { [IO.Directory]::Delete($full, $false) }
        else { [IO.File]::Delete($full) }
    } elseif (($attributes -band [IO.FileAttributes]::Directory)) {
        foreach ($child in [IO.Directory]::GetFileSystemEntries($full)) { Remove-TestTree $child }
        [IO.Directory]::Delete($full, $false)
    } else {
        [IO.File]::SetAttributes($full, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($full)
    }
}

function Write-TestData([string]$Path, [string]$Value = 'synthetic-data-not-a-real-database') {
    $full = Assert-TestTarget $Path
    Assert-TestAncestors $full
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))
    [IO.File]::WriteAllText($full, $Value)
}

function New-Fixture {
    $case = Join-Path $root ([guid]::NewGuid().ToString('N'))
    $local = Join-Path $case 'Local'
    $roaming = Join-Path $case 'Roaming'
    foreach ($relative in @('ApiWorkbench\app.db', 'ApiWorkbench\app.db-wal',
        'ApiWorkbench\backups\history\db.sqlite', 'local.apiworkbench.desktop\EBWebView\Default\cache.bin')) {
        Write-TestData (Join-Path $local $relative)
    }
    Write-TestData (Join-Path $roaming 'local.apiworkbench.desktop\framework.cache\nested\cache.bin')
    foreach ($relative in @('Yaak\keep', 'ApiWorkbenchData\keep', 'manual-exports\keep',
        'sharedWebView2\keep', 'ApiWorkbench-other\keep', '.envdock-migration-test\backup\app.db',
        'local.apiworkbench.desktop-other\keep')) {
        Write-TestData (Join-Path $local $relative) 'outside-sentinel'
    }
    Write-TestData (Join-Path $case 'outside\sentinel') 'outside-sentinel'
    return @{
        Case = $case
        Arguments = @{ LocalApplicationData = $local; ApplicationData = $roaming; Purge = $true }
        Targets = @((Join-Path $local 'ApiWorkbench'), (Join-Path $local 'local.apiworkbench.desktop'),
            (Join-Path $roaming 'local.apiworkbench.desktop'))
    }
}

function Get-Snapshot([string]$Path) {
    $attributes = Get-TestAttributes $Path
    if ($null -eq $attributes) { return '<absent>' }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint)) { return '<link>' }
    if (($attributes -band [IO.FileAttributes]::Directory)) {
        $rows = foreach ($child in ([IO.Directory]::GetFileSystemEntries($Path) | Sort-Object)) {
            [IO.Path]::GetFileName($child) + ':' + (Get-Snapshot $child)
        }
        return ($rows -join '|')
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-Rejected($Fixture, [string]$Pattern = 'Remaining path') {
    $before = Get-Snapshot $Fixture.Case
    $caught = $null
    $arguments = $Fixture.Arguments
    try { Invoke-UninstallDataCleanup @arguments | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught) 'Expected cleanup rejection.'
    Assert-True ($caught.ToString() -match $Pattern) "Wrong rejection: $caught"
    Assert-True ((Get-Snapshot $Fixture.Case) -ceq $before) 'Preflight failure changed the fixture.'
}

function New-TestJunction([string]$Path, [string]$Target) {
    [void](Assert-TestTarget $Path)
    [void](Assert-TestTarget $Target)
    Assert-TestAncestors $Target
    [void](New-Item -ItemType Junction -Path $Path -Target $Target -ErrorAction Stop)
}

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name"
    } catch {
        $script:failed++
        Write-Host "FAIL $Name : $_"
        Write-Host $_.ScriptStackTrace
    }
}

function Invoke-TestChild([string]$Code) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
    $exe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $exe
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return @{ ExitCode = $process.ExitCode; Output = $stdout + $stderr }
    } finally { $process.Dispose() }
}

Assert-True ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) 'Run with Windows PowerShell 5.1.'
Assert-TestAncestors $temporary
[void][IO.Directory]::CreateDirectory($root)
try {
    if (-not [IO.File]::Exists($implementation)) {
        Test-Case 'cleanup implementation exists (TDD RED)' {
            Assert-True $false 'Required uninstall-data.ps1 has not been implemented.'
        }
    } else {
        . $implementation
        Test-Case 'dot-source only defines functions' {
            Assert-True ($null -ne (Get-Command Invoke-UninstallDataCleanup -ErrorAction Stop)) 'Missing cleanup function.'
        }
        Test-Case 'no Purge leaves all synthetic data untouched' {
            $f = New-Fixture
            $a = $f.Arguments; $a.Purge = $false
            $before = Get-Snapshot $f.Case
            Invoke-UninstallDataCleanup @a
            Assert-True ((Get-Snapshot $f.Case) -ceq $before) 'No-Purge modified data.'
        }
        Test-Case 'no Purge does not resolve or validate roots' {
            Invoke-UninstallDataCleanup -LocalApplicationData 'invalid' -ApplicationData 'invalid'
        }
        Test-Case 'fixed three targets, nested backups and framework caches; unrelated siblings survive' {
            $f = New-Fixture
            $a = $f.Arguments
            Invoke-UninstallDataCleanup @a
            foreach ($target in $f.Targets) { Assert-True ($null -eq (Get-TestAttributes $target)) 'Owned target remains.' }
            foreach ($relative in @('Yaak\keep', 'ApiWorkbenchData\keep', 'manual-exports\keep',
                'sharedWebView2\keep', 'ApiWorkbench-other\keep', '.envdock-migration-test\backup\app.db',
                'local.apiworkbench.desktop-other\keep')) {
                Assert-True ([IO.File]::ReadAllText((Join-Path $a.LocalApplicationData $relative)) -eq 'outside-sentinel') 'Outside data changed.'
            }
            Assert-True ([IO.File]::ReadAllText((Join-Path $f.Case 'outside\sentinel')) -eq 'outside-sentinel') 'Outside sentinel changed.'
        }
        Test-Case 'all missing directories are idempotent success' {
            $f = New-Fixture; $a = $f.Arguments
            foreach ($target in $f.Targets) { Remove-TestTree $target }
            Invoke-UninstallDataCleanup @a
            Invoke-UninstallDataCleanup @a
        }
        Test-Case 'empty owned roots and a missing third root are supported' {
            $f = New-Fixture; $a = $f.Arguments
            foreach ($target in $f.Targets) { Remove-TestTree $target }
            [void][IO.Directory]::CreateDirectory($f.Targets[0])
            [void][IO.Directory]::CreateDirectory($f.Targets[1])
            Invoke-UninstallDataCleanup @a
            foreach ($target in $f.Targets) { Assert-True ($null -eq (Get-TestAttributes $target)) 'Empty root remains.' }
        }
        Test-Case 'missing special-folder parents are harmless, not created' {
            $f = New-Fixture; $a = $f.Arguments
            $a.LocalApplicationData = Join-Path $f.Case 'absent-local'
            $a.ApplicationData = Join-Path $f.Case 'absent-roaming'
            $before = Get-Snapshot $f.Case
            Invoke-UninstallDataCleanup @a
            Assert-True ((Get-Snapshot $f.Case) -ceq $before) 'Missing parents were created.'
        }
        foreach ($variant in @('drive-root', 'relative', 'dotdot', 'trailing-dot', 'trailing-space',
            'wildcard', 'ads', 'unc', 'device', 'short-name', 'forward-slash', 'same-roots', 'nested-roots', 'one-root')) {
            Test-Case "reject noncanonical/unsafe roots: $variant" {
                $f = New-Fixture; $a = $f.Arguments
                switch ($variant) {
                    'drive-root' { $a.LocalApplicationData = [IO.Path]::GetPathRoot($root) }
                    'relative' { $a.LocalApplicationData = '.\Local' }
                    'dotdot' { $a.LocalApplicationData += '\..\Local' }
                    'trailing-dot' { $a.LocalApplicationData += '.' }
                    'trailing-space' { $a.LocalApplicationData += ' ' }
                    'wildcard' { $a.LocalApplicationData += '*' }
                    'ads' { $a.LocalApplicationData += ':stream' }
                    'unc' { $a.LocalApplicationData = '\\localhost\share\Local' }
                    'device' { $a.LocalApplicationData = '\\?\D:\Local' }
                    'short-name' { $a.LocalApplicationData += '~1' }
                    'forward-slash' { $a.LocalApplicationData = $a.LocalApplicationData.Replace('\', '/') }
                    'same-roots' { $a.ApplicationData = $a.LocalApplicationData }
                    'nested-roots' { $a.ApplicationData = Join-Path $a.LocalApplicationData 'nested' }
                    'one-root' { $a.Remove('ApplicationData') }
                }
                Assert-Rejected $f
            }
        }
        Test-Case 'file at owned directory name rejects all before deleting' {
            $f = New-Fixture
            Remove-TestTree $f.Targets[2]
            Write-TestData $f.Targets[2]
            Assert-Rejected $f
        }
        Test-Case 'owned root junction rejects all; outside sentinel survives' {
            $f = New-Fixture
            Remove-TestTree $f.Targets[2]
            New-TestJunction $f.Targets[2] (Join-Path $f.Case 'outside')
            Assert-Rejected $f
        }
        Test-Case 'ancestor junction rejects before traversal' {
            $f = New-Fixture
            $junction = Join-Path $f.Case 'ancestor-link'
            New-TestJunction $junction $f.Arguments.LocalApplicationData
            $f.Arguments.LocalApplicationData = Join-Path $junction 'nested'
            Assert-Rejected $f
        }
        Test-Case 'nested junction in last target preflights before deleting first target' {
            $f = New-Fixture
            New-TestJunction (Join-Path $f.Targets[2] 'framework.cache\outside-link') (Join-Path $f.Case 'outside')
            Assert-Rejected $f
        }
        Test-Case 'dangling nested junction is rejected, not mistaken for missing' {
            $f = New-Fixture
            $outside = Join-Path $f.Case 'dangling-target'
            [void][IO.Directory]::CreateDirectory($outside)
            New-TestJunction (Join-Path $f.Targets[2] 'dangling') $outside
            [IO.Directory]::Delete((Assert-TestTarget $outside), $false)
            Assert-Rejected $f
        }
        Test-Case 'locked file in last root blocks deletion of every root and reports no contents' {
            $f = New-Fixture; $a = $f.Arguments
            $locked = Join-Path $f.Targets[2] 'locked.db'
            Write-TestData $locked 'SECRET-CONTENT-DO-NOT-LOG'
            $before = Get-Snapshot $f.Case
            $handle = [IO.File]::Open($locked, 'Open', 'ReadWrite', 'None')
            try {
                $caught = $null
                try { Invoke-UninstallDataCleanup @a } catch { $caught = $_ }
                Assert-True ($null -ne $caught) 'Locked file was not rejected.'
                Assert-True ($caught.ToString() -match 'Remaining path') 'Remaining-path error missing.'
                Assert-True ($caught.ToString() -notmatch 'SECRET-CONTENT|locked.db') 'Sensitive contents/names leaked.'
                foreach ($target in $f.Targets) { Assert-True ([IO.Directory]::Exists($target)) 'Earlier root deleted before lock preflight.' }
                Assert-True ([IO.File]::Exists((Join-Path $f.Targets[0] 'app.db'))) 'Earlier DB deleted.'
            } finally { $handle.Dispose() }
            Assert-True ([IO.File]::ReadAllText($locked) -eq 'SECRET-CONTENT-DO-NOT-LOG') 'Locked data changed.'
            Assert-True ((Get-Snapshot $f.Case) -ceq $before) 'Some data changed during lock preflight failure.'
        }
        Test-Case 'read-only file rejected before deletion; preflight handles released on failure' {
            $f = New-Fixture; $a = $f.Arguments
            $file = Join-Path $f.Targets[2] 'readonly.db'
            Write-TestData $file
            [IO.File]::SetAttributes($file, [IO.FileAttributes]::ReadOnly)
            Assert-Rejected $f
            [IO.File]::SetAttributes($file, [IO.FileAttributes]::Normal)
            Invoke-UninstallDataCleanup @a
        }
        Test-Case 'hidden/system files and literal bracket names are cleaned' {
            $f = New-Fixture; $a = $f.Arguments
            $file = Join-Path $f.Targets[0] 'cache[1].bin'
            Write-TestData $file
            [IO.File]::SetAttributes($file, ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System))
            Invoke-UninstallDataCleanup @a
            Assert-True ($null -eq (Get-TestAttributes $f.Targets[0])) 'Literal or hidden file remains.'
        }
        Test-Case 'inspection errors fail closed, sanitize errors, release preflight handles' {
            $f = New-Fixture; $a = $f.Arguments
            $originalAttributes = ${function:Get-UninstallDataAttributes}
            $blockedRoot = $f.Targets[2]
            function Get-UninstallDataAttributes([string]$Path) {
                if ($Path -eq $blockedRoot) { throw 'SECRET-EXCEPTION-CONTENT' }
                & $originalAttributes $Path
            }
            try {
                Assert-Rejected $f
                $caught = $null
                try { Invoke-UninstallDataCleanup @a } catch { $caught = $_ }
                Assert-True ($caught.ToString() -notmatch 'SECRET-EXCEPTION-CONTENT') 'Raw error leaked.'
            } finally { Set-Item -LiteralPath Function:Get-UninstallDataAttributes -Value $originalAttributes }
            # Would fail if earlier exclusively opened handles leaked on rejection.
            Invoke-UninstallDataCleanup @a
        }
        Test-Case 'new child after preflight fails nonrecursively and reports surviving root' {
            $f = New-Fixture; $a = $f.Arguments
            $originalOwnedPath = ${function:Assert-UninstallOwnedPath}
            $lateFile = Join-Path $f.Targets[2] 'late-arrival.db'
            function Assert-UninstallOwnedPath([string]$Path, [string]$Root) {
                # Fault injection at the validation boundary, not a production hook.
                if ($stage -eq 'deletion' -and -not [IO.File]::Exists($lateFile)) {
                    Write-TestData $lateFile 'late-sentinel'
                }
                & $originalOwnedPath $Path $Root
            }
            try {
                $caught = $null
                try { Invoke-UninstallDataCleanup @a } catch { $caught = $_ }
                Assert-True ($null -ne $caught) 'Unexpected recursive deletion/silent success.'
                Assert-True ($caught.ToString().Contains($f.Targets[2])) 'Remaining root not identified.'
                Assert-True ([IO.File]::ReadAllText($lateFile) -eq 'late-sentinel') 'Unplanned child deleted.'
                Assert-True ([IO.File]::ReadAllText((Join-Path $f.Case 'outside\sentinel')) -eq 'outside-sentinel') 'Outside data changed.'
            } finally { Set-Item -LiteralPath Function:Assert-UninstallOwnedPath -Value $originalOwnedPath }
            Invoke-UninstallDataCleanup @a
        }
        Test-Case 'all preflight file handles are held until deletion begins' {
            $f = New-Fixture; $a = $f.Arguments
            $originalOwnedPath = ${function:Assert-UninstallOwnedPath}
            $probeFile = Join-Path $f.Targets[0] 'app.db'
            $lastRoot = $f.Targets[2]
            $script:probeChecked = $false
            function Assert-UninstallOwnedPath([string]$Path, [string]$Root) {
                if ($stage -eq 'preflight' -and $Path -eq $lastRoot) {
                    $opened = $null
                    try { $opened = [IO.File]::Open($probeFile, 'Open', 'ReadWrite', 'None') }
                    catch [IO.IOException] { $script:probeChecked = $true }
                    if ($opened) {
                        $opened.Dispose()
                        throw 'Preflight handle was not held.'
                    }
                }
                & $originalOwnedPath $Path $Root
            }
            try {
                Invoke-UninstallDataCleanup @a
                Assert-True $script:probeChecked 'Did not observe exclusive preflight handle.'
            } finally { Set-Item -LiteralPath Function:Assert-UninstallOwnedPath -Value $originalOwnedPath }
        }
        Test-Case 'production roots use .NET special folders, not ambient environment' {
            $f = New-Fixture
            $oldLocal = $env:LOCALAPPDATA; $oldRoaming = $env:APPDATA
            try {
                $expectedLocal = [Environment]::GetFolderPath('LocalApplicationData')
                $expectedRoaming = [Environment]::GetFolderPath('ApplicationData')
                $env:LOCALAPPDATA = $f.Arguments.LocalApplicationData
                $env:APPDATA = $f.Arguments.ApplicationData
                $resolved = Get-UninstallDataRoots
                Assert-True ($resolved.LocalApplicationData -eq $expectedLocal) 'Local root uses ambient env.'
                Assert-True ($resolved.ApplicationData -eq $expectedRoaming) 'Roaming root uses ambient env.'
            } finally { $env:LOCALAPPDATA = $oldLocal; $env:APPDATA = $oldRoaming }
        }
        Test-Case 'script exposes Purge only; no CLI root override' {
            $tokens = $null; $errors = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($implementation, [ref]$tokens, [ref]$errors)
            Assert-True ($errors.Count -eq 0) 'Parse errors.'
            $names = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
            Assert-True ($names.Count -eq 1 -and $names[0] -eq 'Purge') 'CLI accepts a root override.'
        }
        Test-Case 'real script without Purge exits zero without cleanup' {
            $result = Invoke-TestChild ("& '" + $implementation.Replace("'", "''") + "'; exit `$LASTEXITCODE")
            Assert-True ($result.ExitCode -eq 0) 'No-Purge CLI failed.'
        }
        Test-Case 'dot-source with Purge still only loads definitions' {
            # Never pass -Purge to the real script: a regressed entry guard would
            # otherwise delete real profile data before this assertion can fail.
            $f = New-Fixture
            $localRoot = Assert-TestTarget $f.Arguments.LocalApplicationData
            $roamingRoot = Assert-TestTarget $f.Arguments.ApplicationData
            Assert-TestAncestors $localRoot
            Assert-TestAncestors $roamingRoot
            $text = [IO.File]::ReadAllText($implementation)
            $tokens = $null; $errors = $null
            $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
            Assert-True ($errors.Count -eq 0) 'Production script parse error.'
            $resolver = @($ast.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-UninstallDataRoots'
            }, $true))
            Assert-True ($resolver.Count -eq 1) 'Expected exactly one root resolver.'
            $extent = $resolver[0].Extent
            $before = $text.Substring(0, $extent.StartOffset)
            $after = $text.Substring($extent.EndOffset)
            $localExpression = '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)'
            $roamingExpression = '[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)'
            foreach ($expression in @($localExpression, $roamingExpression)) {
                Assert-True ([regex]::Matches($extent.Text, [regex]::Escape($expression)).Count -eq 1) 'Root resolver changed; unsafe substitution refused.'
            }
            $localLiteral = "'" + $localRoot.Replace("'", "''") + "'"
            $roamingLiteral = "'" + $roamingRoot.Replace("'", "''") + "'"
            $functionCopy = $extent.Text.Replace($localExpression, $localLiteral).Replace($roamingExpression, $roamingLiteral)
            $copy = $before + $functionCopy + $after
            $roundTrip = $before + $functionCopy.Replace($localLiteral, $localExpression).Replace($roamingLiteral, $roamingExpression) + $after
            Assert-True ($roundTrip -ceq $text) 'Fixture changed more than root resolution.'
            # Evaluate ONLY the copied resolver, not the script entry point.
            $resolved = & ([scriptblock]::Create($functionCopy + "`nGet-UninstallDataRoots"))
            Assert-True ($resolved.LocalApplicationData -ceq $localRoot -and $resolved.ApplicationData -ceq $roamingRoot) 'Resolver escaped synthetic roots.'
            $dotSourceScript = Join-Path $f.Case 'uninstall-data.ps1'
            [void](Assert-TestTarget $dotSourceScript)
            Assert-TestAncestors $dotSourceScript
            [IO.File]::WriteAllText($dotSourceScript, $copy, (New-Object Text.UTF8Encoding $true))
            Assert-True ([IO.File]::ReadAllText($dotSourceScript) -ceq $copy) 'Fixture script content mismatch.'
            $snapshot = Get-Snapshot $f.Case
            $result = Invoke-TestChild (". '" + $dotSourceScript.Replace("'", "''") + "' -Purge; exit 42")
            Assert-True ($result.ExitCode -eq 42) 'Dot-sourcing executed the script entry point.'
            Assert-True ((Get-Snapshot $f.Case) -ceq $snapshot) 'Dot-sourcing changed synthetic data.'
        }
        # Exercise the real main/exit adapter in children, replacing ONLY the function
        # that resolves special folders. Never launch production CLI with -Purge.
        foreach ($mode in @('success', 'failure')) {
            Test-Case "main exit adapter using synthetic roots: $mode" {
                $f = New-Fixture
                if ($mode -eq 'failure') {
                    New-TestJunction (Join-Path $f.Targets[2] 'outside-link') (Join-Path $f.Case 'outside')
                }
                $code = ". '" + $implementation.Replace("'", "''") + "'; "
                $code += "function Get-UninstallDataRoots { @{ LocalApplicationData = '" + $f.Arguments.LocalApplicationData.Replace("'", "''")
                $code += "'; ApplicationData = '" + $f.Arguments.ApplicationData.Replace("'", "''") + "' } }; "
                $code += 'exit (Invoke-UninstallDataMain -Purge)'
                $result = Invoke-TestChild $code
                if ($mode -eq 'success') {
                    Assert-True ($result.ExitCode -eq 0) 'Success exit code was not zero.'
                    foreach ($target in $f.Targets) { Assert-True ($null -eq (Get-TestAttributes $target)) 'Target remains.' }
                } else {
                    Assert-True ($result.ExitCode -eq 1) 'Failure exit code was not one.'
                    Assert-True ($result.Output -match 'Remaining path') 'Failure did not report remaining path.'
                    Assert-True ([IO.File]::Exists((Join-Path $f.Targets[0] 'app.db'))) 'Preflight failure deleted DB.'
                }
            }
        }
    }
} finally {
    Remove-TestTree $root
}
Write-Host ("Windows PowerShell {0}; passed={1}; failed={2}" -f $PSVersionTable.PSVersion, $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
