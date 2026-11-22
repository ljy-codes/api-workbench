# Synthetic files only. Run with Windows PowerShell 5.1; no Pester/SQLite/Python.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$project = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path $project '.tmp'
$root = Join-Path $temporary ('migration-tests-' + [guid]::NewGuid().ToString('N'))
$implementation = Join-Path $PSScriptRoot 'migrate-local-data.ps1'
$script:passed = 0
$script:failed = 0

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# Do not follow a junction during test setup or cleanup.
function Assert-TestPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $testRoot = [IO.Path]::GetFullPath($root)
    if ($full -ne $testRoot -and -not $full.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup outside test root: $full"
    }
    return $full
}

function Remove-TestTree([string]$Path) {
    $full = Assert-TestPath $Path
    if (-not (Test-Path -LiteralPath $full)) { return }
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($item.PSIsContainer) { [IO.Directory]::Delete($full) }
        else { [IO.File]::Delete($full) }
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $full -Force) { Remove-TestTree $child.FullName }
        [IO.Directory]::Delete($full)
    } else { [IO.File]::Delete($full) }
}

function Write-Data([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value)
}

function New-Fixture {
    $case = Join-Path $root ([guid]::NewGuid().ToString('N'))
    $source = Join-Path $case 'source'
    $destination = Join-Path $case 'destination'
    [void][IO.Directory]::CreateDirectory((Join-Path $source 'backups'))
    [void][IO.Directory]::CreateDirectory($destination)
    Write-Data (Join-Path $source 'app.db') 'synthetic database - not SQLite'
    Write-Data (Join-Path $source 'app.db-wal') 'synthetic WAL'
    Write-Data (Join-Path $source 'app.db-shm') 'synthetic SHM'
    Write-Data (Join-Path $source 'backups\history.sqlite') 'original historical backup'
    Write-Data (Join-Path $destination 'keep.txt') 'unrelated destination file'
    return @{ SourceDirectory = $source; DestinationDirectory = $destination; ConfirmSameWindowsUser = $true }
}

function Get-Snapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '<absent>' }
    $rows = foreach ($item in Get-ChildItem -LiteralPath $Path -Force | Sort-Object Name) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            'LINK:' + $item.Name
        } elseif ($item.PSIsContainer) {
            'DIR:' + $item.Name + ':' + (Get-Snapshot $item.FullName)
        } else {
            $item.Name + ':' + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        }
    }
    return ($rows -join '|')
}

function Assert-Rejected($Arguments, [string]$Pattern) {
    $beforeSource = Get-Snapshot $Arguments.SourceDirectory
    $beforeDestination = Get-Snapshot $Arguments.DestinationDirectory
    $caught = $null
    try { Invoke-LocalDataMigration @Arguments | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught) 'Expected rejection, migration succeeded'
    Assert-True ($caught.ToString() -match $Pattern) "Wrong rejection: $caught"
    Assert-True ((Get-Snapshot $Arguments.SourceDirectory) -eq $beforeSource) 'Source changed on failure'
    Assert-True ((Get-Snapshot $Arguments.DestinationDirectory) -eq $beforeDestination) 'Destination changed on failure'
}

function Test-Case([string]$TestName, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $TestName"
    } catch {
        $script:failed++
        Write-Host "FAIL $TestName : $_"
        Write-Host $_.ScriptStackTrace
    }
}

# Check every existing ancestor before creating any test directory.
$ancestor = $temporary
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse test root refused' }
    }
    $ancestor = Split-Path -Parent $ancestor
}
[void][IO.Directory]::CreateDirectory($root)
try {
    if (-not (Test-Path -LiteralPath $implementation)) {
        Test-Case 'migration implementation exists (TDD RED)' {
            Assert-True $false 'Required migrate-local-data.ps1 has not been implemented'
        }
    } else {
        # Dot-sourcing defines functions only; it MUST NOT run a migration.
        . $implementation -SourceDirectory $root
        $originalCopy = ${function:Copy-MigrationStream}
        $originalMove = ${function:Move-MigrationFile}
        # Isolate ALL migration tests from real EnvDock processes.
        function Get-MigrationProcesses { @() }

        Test-Case 'success, WAL/SHM hashes, backup first, locks held, history preserved' {
            $f = New-Fixture
            $before = Get-Snapshot $f.SourceDirectory
            $script:copies = 0
            $script:lockedFiles = @('app.db', 'app.db-wal', 'app.db-shm') | ForEach-Object { Join-Path $f.SourceDirectory $_ }
            function Copy-MigrationStream($Stream, $Path) {
                $script:copies++
                foreach ($file in $script:lockedFiles) {
                    $opened = $null
                    try { $opened = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None') } catch [IO.IOException] { }
                    if ($opened) { $opened.Dispose(); throw 'Source not exclusively locked' }
                }
                if ($Path -match '\\payload\\') {
                    $backup = Join-Path (Split-Path (Split-Path $Path -Parent) -Parent) 'backup'
                    foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm')) {
                        Assert-True (Test-Path -LiteralPath (Join-Path $backup $name)) 'Payload copied before all backups'
                    }
                }
                & $originalCopy $Stream $Path
            }
            $result = Invoke-LocalDataMigration @f
            Assert-True ($script:copies -eq 6) 'Expected backup and payload copies'
            foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm')) {
                $expected = (Get-FileHash -LiteralPath (Join-Path $f.SourceDirectory $name)).Hash
                Assert-True ((Get-FileHash -LiteralPath (Join-Path $f.DestinationDirectory $name)).Hash -eq $expected) 'Destination hash mismatch'
                Assert-True ((Get-FileHash -LiteralPath (Join-Path $result.BackupDirectory $name)).Hash -eq $expected) 'Backup hash mismatch'
            }
            Assert-True ((Get-Snapshot $f.SourceDirectory) -eq $before) 'Source changed'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'backups'))) 'History must stay at source'
            Assert-True ((Get-Content -LiteralPath (Join-Path $f.DestinationDirectory 'keep.txt')) -eq 'unrelated destination file') 'Unrelated file changed'
        }

        Test-Case 'database without sidecars' {
            $f = New-Fixture
            foreach ($name in @('app.db-wal', 'app.db-shm')) { [IO.File]::Delete((Assert-TestPath (Join-Path $f.SourceDirectory $name))) }
            Invoke-LocalDataMigration @f | Out-Null
            Assert-True (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'app.db')) 'Missing destination'
        }
        foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm')) {
            Test-Case "existing target $name refuses overwrite" {
                $f = New-Fixture
                Write-Data (Join-Path $f.DestinationDirectory $name) 'must not overwrite'
                Assert-Rejected $f 'already exists'
            }
            Test-Case "locked source $name refuses before writing" {
                $f = New-Fixture
                $before = Get-Snapshot $f.SourceDirectory
                $targetBefore = Get-Snapshot $f.DestinationDirectory
                $handle = [IO.File]::Open((Join-Path $f.SourceDirectory $name), 'Open', 'ReadWrite', 'None')
                $caught = $null
                try { Invoke-LocalDataMigration @f | Out-Null } catch { $caught = $_ } finally { $handle.Dispose() }
                Assert-True ($null -ne $caught -and $caught.ToString() -match 'locked') "Expected lock rejection: $caught"
                Assert-True ((Get-Snapshot $f.SourceDirectory) -eq $before) 'Locked source changed'
                Assert-True ((Get-Snapshot $f.DestinationDirectory) -eq $targetBefore) 'Target changed'
            }
        }
        Test-Case 'same path including dot alias' {
            $f = New-Fixture
            $f.DestinationDirectory = $f.SourceDirectory + '\.'
            Assert-Rejected $f 'same or nested'
        }
        Test-Case 'target nested in source' {
            $f = New-Fixture
            $f.DestinationDirectory = Join-Path $f.SourceDirectory 'child'
            Assert-Rejected $f 'same or nested'
        }
        Test-Case 'source nested in target' {
            $f = New-Fixture
            $f.DestinationDirectory = Split-Path -Parent $f.SourceDirectory
            Assert-Rejected $f 'same or nested'
        }
        Test-Case 'missing same-user confirmation' {
            $f = New-Fixture
            $f.ConfirmSameWindowsUser = $false
            Assert-Rejected $f 'ConfirmSameWindowsUser'
        }
        Test-Case 'different source owner' {
            $f = New-Fixture
            function Get-MigrationOwnerSid($Path) { 'S-1-5-18' }
            Assert-Rejected $f 'owner'
        }
        Test-Case 'rollback journal refused' {
            $f = New-Fixture
            Write-Data (Join-Path $f.SourceDirectory 'app.db-journal') 'possible hot journal'
            Assert-Rejected $f 'journal'
        }
        foreach ($processName in @('EnvDock', 'api-workbench', ([string][char]0x63a5 + [char]0x53e3 + [char]0x5de5 + [char]0x5177))) {
            Test-Case "running process $processName refuses" {
                $f = New-Fixture
                function Get-MigrationProcesses { [pscustomobject]@{ ProcessName = $processName } }
                Assert-Rejected $f 'running'
            }
        }
        Test-Case 'process inspection failure refuses' {
            $f = New-Fixture
            function Get-MigrationProcesses { throw 'process inspection unavailable' }
            Assert-Rejected $f 'process inspection unavailable'
        }
        foreach ($faultAt in @(1, 4, 6)) {
            Test-Case "copy failure at $faultAt leaves originals and target unchanged" {
                $f = New-Fixture
                $script:copies = 0
                function Copy-MigrationStream($Stream, $Path) {
                    $script:copies++
                    if ($script:copies -eq $faultAt) {
                        Write-Data $Path 'partial'
                        throw 'injected copy failure'
                    }
                    & $originalCopy $Stream $Path
                }
                Assert-Rejected $f 'injected copy failure'
            }
        }
        Test-Case 'corrupt copy rejected by SHA256' {
            $f = New-Fixture
            function Copy-MigrationStream($Stream, $Path) {
                & $originalCopy $Stream $Path
                Write-Data $Path 'corruption'
            }
            Assert-Rejected $f 'hash'
        }
        Test-Case 'late process detection prevents publication' {
            $f = New-Fixture
            $script:checks = 0
            function Get-MigrationProcesses {
                $script:checks++
                if ($script:checks -gt 1) { [pscustomobject]@{ ProcessName = 'EnvDock' } }
            }
            Assert-Rejected $f 'running'
        }
        Test-Case 'process starts after sidecar publication: rollback sidecars' {
            $f = New-Fixture
            $script:checks = 0
            function Get-MigrationProcesses {
                $script:checks++
                if ($script:checks -gt 2) { [pscustomobject]@{ ProcessName = 'EnvDock' } }
            }
            Assert-Rejected $f 'running'
        }
        foreach ($moveFaultAt in @(2, 3)) {
            Test-Case "publication failure at $moveFaultAt rolls back sidecars" {
                $f = New-Fixture
                $script:moves = 0
                function Move-MigrationFile($Source, $Destination) {
                    $script:moves++
                    if ($script:moves -eq $moveFaultAt) { throw 'injected publication failure' }
                    & $originalMove $Source $Destination
                }
                Assert-Rejected $f 'injected publication failure'
            }
        }
        Test-Case 'publication failure restores absent destination' {
            $f = New-Fixture
            Remove-TestTree $f.DestinationDirectory
            function Move-MigrationFile($Source, $Destination) { throw 'injected publication failure' }
            Assert-Rejected $f 'injected publication failure'
        }
        Test-Case 'concurrent target app.db creation never overwritten or removed' {
            $f = New-Fixture
            $before = Get-Snapshot $f.SourceDirectory
            function Move-MigrationFile($Source, $Destination) {
                if ([IO.Path]::GetFileName($Destination) -eq 'app.db') {
                    Write-Data $Destination 'concurrently created database'
                }
                & $originalMove $Source $Destination
            }
            $caught = $null
            try { Invoke-LocalDataMigration @f | Out-Null } catch { $caught = $_ }
            Assert-True ($null -ne $caught) 'Expected non-overwriting move to fail'
            Assert-True ((Get-Content -LiteralPath (Join-Path $f.DestinationDirectory 'app.db')) -eq 'concurrently created database') 'Concurrent database changed'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'app.db-wal'))) 'Published WAL not rolled back'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'app.db-shm'))) 'Published SHM not rolled back'
            Assert-True ((Get-Snapshot $f.SourceDirectory) -eq $before) 'Source changed'
        }
        Test-Case 'unexpected target WAL before commit refuses mixed database state' {
            $f = New-Fixture
            [IO.File]::Delete((Assert-TestPath (Join-Path $f.SourceDirectory 'app.db-wal')))
            $before = Get-Snapshot $f.SourceDirectory
            $script:unexpectedWal = Join-Path $f.DestinationDirectory 'app.db-wal'
            $script:checks = 0
            function Get-MigrationProcesses {
                $script:checks++
                if ($script:checks -eq 3) { Write-Data $script:unexpectedWal 'external WAL' }
            }
            $caught = $null
            try { Invoke-LocalDataMigration @f | Out-Null } catch { $caught = $_ }
            Assert-True ($null -ne $caught -and $caught.ToString() -match 'already exists') "Expected destination conflict: $caught"
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'app.db'))) 'Database published with unrelated WAL'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.DestinationDirectory 'app.db-shm'))) 'Own sidecar not rolled back'
            Assert-True ((Get-Content -LiteralPath $script:unexpectedWal) -eq 'external WAL') 'External WAL changed'
            Assert-True ((Get-Snapshot $f.SourceDirectory) -eq $before) 'Source changed'
        }
        foreach ($newSidecar in @('app.db-journal', 'app.db-wal')) {
            Test-Case "new source $newSidecar during staging refuses publication" {
                $f = New-Fixture
                $script:addedPath = Join-Path $f.SourceDirectory $newSidecar
                if (Test-Path -LiteralPath $script:addedPath) { [IO.File]::Delete((Assert-TestPath $script:addedPath)) }
                $beforeSource = Get-Snapshot $f.SourceDirectory
                $beforeDestination = Get-Snapshot $f.DestinationDirectory
                function Copy-MigrationStream($Stream, $Path) {
                    & $originalCopy $Stream $Path
                    Write-Data $script:addedPath 'concurrently created sidecar'
                }
                $caught = $null
                try { Invoke-LocalDataMigration @f | Out-Null } catch { $caught = $_ }
                Assert-True ($null -ne $caught -and $caught.ToString() -match 'sidecar set changed') "Expected changed-source rejection: $caught"
                Assert-True ((Get-Snapshot $f.DestinationDirectory) -eq $beforeDestination) 'Destination changed'
                Assert-True ((Get-Content -LiteralPath $script:addedPath) -eq 'concurrently created sidecar') 'Concurrent source file changed'
                [IO.File]::Delete((Assert-TestPath $script:addedPath))
                Assert-True ((Get-Snapshot $f.SourceDirectory) -eq $beforeSource) 'Original source changed'
            }
        }
        Test-Case 'missing source database' {
            $f = New-Fixture
            [IO.File]::Delete((Assert-TestPath (Join-Path $f.SourceDirectory 'app.db')))
            Assert-Rejected $f 'does not exist'
        }
        Test-Case 'source database directory refused' {
            $f = New-Fixture
            [IO.File]::Delete((Assert-TestPath (Join-Path $f.SourceDirectory 'app.db')))
            [void][IO.Directory]::CreateDirectory((Join-Path $f.SourceDirectory 'app.db'))
            Assert-Rejected $f 'Expected source file'
        }
        foreach ($location in @('source-db', 'source-wal', 'target-db')) {
            Test-Case "reparse file slot $location refused" {
                $f = New-Fixture
                if ($location -eq 'target-db') {
                    $link = Join-Path $f.DestinationDirectory 'app.db'
                } else {
                    $leaf = 'app.db'
                    if ($location -eq 'source-wal') { $leaf = 'app.db-wal' }
                    $link = Join-Path $f.SourceDirectory $leaf
                    [IO.File]::Delete((Assert-TestPath $link))
                }
                New-Item -ItemType Junction -Path $link -Target (Join-Path $f.SourceDirectory 'backups') | Out-Null
                try { Assert-Rejected $f 'reparse' } finally { [IO.Directory]::Delete((Assert-TestPath $link)) }
            }
        }
        foreach ($location in @('source', 'destination', 'source-ancestor', 'destination-ancestor', 'backups')) {
            Test-Case "reparse $location refused" {
                $f = New-Fixture
                $base = Split-Path -Parent $f.SourceDirectory
                $link = Join-Path $base 'junction'
                switch ($location) {
                    'source' {
                        New-Item -ItemType Junction -Path $link -Target $f.SourceDirectory | Out-Null
                        $f.SourceDirectory = $link
                    }
                    'destination' {
                        New-Item -ItemType Junction -Path $link -Target $f.DestinationDirectory | Out-Null
                        $f.DestinationDirectory = $link
                    }
                    'source-ancestor' {
                        New-Item -ItemType Junction -Path $link -Target $base | Out-Null
                        $f.SourceDirectory = Join-Path $link 'source'
                    }
                    'destination-ancestor' {
                        New-Item -ItemType Junction -Path $link -Target $base | Out-Null
                        $f.DestinationDirectory = Join-Path $link 'destination'
                    }
                    'backups' {
                        $link = Join-Path $f.SourceDirectory 'backups'
                        Remove-TestTree $link
                        New-Item -ItemType Junction -Path $link -Target $f.DestinationDirectory | Out-Null
                    }
                }
                try { Assert-Rejected $f 'reparse' } finally { [IO.Directory]::Delete((Assert-TestPath $link)) }
            }
        }
        Test-Case 'default destination uses isolated LOCALAPPDATA' {
            $f = New-Fixture
            $saved = $env:LOCALAPPDATA
            try {
                $env:LOCALAPPDATA = Split-Path -Parent $f.DestinationDirectory
                $f.Remove('DestinationDirectory')
                $result = Invoke-LocalDataMigration @f
                Assert-True ($result.DestinationDirectory -eq (Join-Path $env:LOCALAPPDATA 'ApiWorkbench')) 'Wrong default destination'
            } finally { $env:LOCALAPPDATA = $saved }
        }
    }
} finally {
    Remove-TestTree $root
}
Write-Host ("RESULT: {0} passed, {1} failed; PowerShell {2}" -f $script:passed, $script:failed, $PSVersionTable.PSVersion)
if ($script:failed -gt 0) { exit 1 }
