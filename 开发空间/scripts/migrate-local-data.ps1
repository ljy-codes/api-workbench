<#
.SYNOPSIS
Offline, optional portable-data migration. Windows PowerShell 5.1 compatible.
.DESCRIPTION
Run as the ORIGINAL Windows user on the ORIGINAL computer/profile, with every
EnvDock / api-workbench / Chinese-named legacy app closed. No elevation needed.
ConfirmSameWindowsUser is an explicit attestation, NOT proof that every DPAPI
ciphertext decrypts. Ownership is additionally checked; this script does not
parse SQLite, decrypt/re-encrypt credentials, or support cross-user migration.

Copies app.db and existing app.db-wal/app.db-shm byte-for-byte while holding ALL
source handles with FileShare.None. First creates a private SHA256-verified
backup, then verifies staging copies, then publishes sidecars and app.db LAST.
Existing target DB/sidecars/journal are never overwritten. Source is never
modified. Historical backups are NOT copied: retain the source backups folder.
No SQLite integrity check/checkpoint/recovery is attempted; a rollback journal
is refused. Backup DB/WAL/SHM must be kept together, not restored individually.

Success returns BackupDirectory (a unique sibling of the destination).
Do not start either app during migration. Process checks are conservative but
cannot prevent a new process starting between checks. This is not a security
boundary against concurrent hostile directory/ACL changes. On forced process
termination/power loss, a private staging folder or target sidecars may remain;
app.db is published only as a complete, verified file. Inspect leftovers with
both apps stopped; never blindly retry over them.
.EXAMPLE
.\migrate-local-data.ps1 -SourceDirectory 'D:\Portable\ApiWorkbenchData' -ConfirmSameWindowsUser
.EXAMPLE
.\migrate-local-data.ps1 -SourceDirectory 'D:\Portable\ApiWorkbenchData' -DestinationDirectory 'D:\MyData' -ConfirmSameWindowsUser
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,
    [string]$DestinationDirectory,
    [switch]$ConfirmSameWindowsUser
)

function Get-MigrationProcesses {
    Get-Process -ErrorAction Stop
}

function Assert-MigrationStopped {
    $legacyName = [string][char]0x63a5 + [char]0x53e3 + [char]0x5de5 + [char]0x5177
    $names = @('EnvDock', 'api-workbench', $legacyName)
    foreach ($process in @(Get-MigrationProcesses)) {
        if ($names -contains $process.ProcessName) {
            throw "Application is running ($($process.ProcessName)); close all instances first."
        }
    }
}

function Get-MigrationOwnerSid([string]$Path) {
    (Get-Acl -LiteralPath $Path -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value
}

function Get-MigrationAttributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-MigrationPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Use an explicit absolute local drive path (no UNC/device/relative paths).'
    }
    if ($Path.Substring(2).Contains(':') -or $Path.Contains('~')) {
        throw 'Alternate streams and short-name/tilde paths are not supported.'
    }
    foreach ($part in ($Path.Substring(3) -split '[\\/]')) {
        if ($part -ne '.' -and $part -ne '..' -and $part -match '[. ]$') {
            throw 'Trailing dots/spaces in paths are not supported.'
        }
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full.Length -le 3) { throw 'A drive root is not a data directory.' }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)) {
        throw 'Only local fixed/removable drives are supported.'
    }
    $current = $full
    while ($current) {
        $attributes = Get-MigrationAttributes $current
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "A reparse point is not allowed: $current"
        }
        $current = Split-Path -Parent $current
    }
    return $full
}

function Get-MigrationHash($Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '')
    } finally { $sha.Dispose() }
}

function Copy-MigrationStream($Stream, [string]$Path) {
    $output = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $Stream.Position = 0
        $Stream.CopyTo($output)
        $output.Flush($true)
    } finally { $output.Dispose() }
}

function Assert-MigrationHash([string]$Path, [string]$Expected) {
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'None')
    try {
        if ((Get-MigrationHash $stream) -ne $Expected) { throw "SHA256 hash mismatch: $Path" }
    } finally { $stream.Dispose() }
}

function Move-MigrationFile([string]$Source, [string]$Destination) {
    # .NET two-argument Move is non-overwriting, including during a target race.
    [IO.File]::Move($Source, $Destination)
}

function Assert-MigrationTarget([string]$Destination, $Published = @()) {
    [void](Assert-MigrationPath $Destination)
    foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal')) {
        $path = Join-Path $Destination $name
        [void](Assert-MigrationPath $path)
        $own = @($Published | Where-Object { $_.Path -eq $path })
        if ($own.Count -eq 1) {
            Assert-MigrationHash $path $own[0].Hash
        } elseif ($null -ne (Get-MigrationAttributes $path)) {
            throw "Target already exists; no overwrite: $path"
        }
    }
}

function Assert-MigrationSourceSet([string]$Source, $Files) {
    [void](Assert-MigrationPath $Source)
    $expected = @($Files | ForEach-Object { $_.Name })
    foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal')) {
        $path = Join-Path $Source $name
        [void](Assert-MigrationPath $path)
        $exists = $null -ne (Get-MigrationAttributes $path)
        if ($exists -ne ($name -in $expected)) {
            throw 'Source sidecar set changed; close the original app and retry.'
        }
    }
}

function Invoke-LocalDataMigration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [string]$DestinationDirectory,
        [switch]$ConfirmSameWindowsUser
    )
    $ErrorActionPreference = 'Stop'
    if (-not $ConfirmSameWindowsUser) {
        throw 'Require -ConfirmSameWindowsUser: original Windows user AND original computer/profile only (DPAPI).'
    }
    if ([string]::IsNullOrWhiteSpace($DestinationDirectory)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable; specify DestinationDirectory.' }
        $DestinationDirectory = Join-Path $env:LOCALAPPDATA 'ApiWorkbench'
    }
    $source = Assert-MigrationPath $SourceDirectory
    $destination = Assert-MigrationPath $DestinationDirectory
    if ($source.Equals($destination, [StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $destination.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Source and destination must not be the same or nested paths.'
    }
    if (-not [IO.Directory]::Exists($source)) { throw 'Source directory does not exist.' }
    $parent = Split-Path -Parent $destination
    if (-not [IO.Directory]::Exists($parent)) { throw 'Destination parent must already exist; create it explicitly first.' }
    if ([IO.File]::Exists($destination)) { throw 'Destination is a file, not a directory.' }
    Assert-MigrationTarget $destination
    [void](Assert-MigrationPath (Join-Path $source 'backups'))
    if ($null -ne (Get-MigrationAttributes (Join-Path $source 'app.db-journal'))) {
        throw 'Source rollback journal exists; recover/close SQLite with the original app first.'
    }
    Assert-MigrationStopped
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $files = New-Object 'System.Collections.Generic.List[object]'
    $published = New-Object 'System.Collections.Generic.List[object]'
    $work = $null
    $createdDestination = $false
    $committed = $false
    try {
        foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm')) {
            $path = Join-Path $source $name
            [void](Assert-MigrationPath $path)
            $attributes = Get-MigrationAttributes $path
            if ($null -eq $attributes) {
                if ($name -eq 'app.db') { throw 'Source app.db does not exist.' }
                continue
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw "Expected source file: $path" }
            if ((Get-MigrationOwnerSid $path) -ne $sid.Value) {
                throw "Source file owner is not the current Windows user; same-user migration only: $path"
            }
            try { $stream = [IO.File]::Open($path, 'Open', 'Read', 'None') }
            catch { throw "Source file is locked or inaccessible; migration refused: $path" }
            $entry = [pscustomobject]@{ Name = $name; Stream = $stream; Hash = $null }
            $files.Add($entry)
        }
        # Every source handle stays open until commit/rollback has finished.
        foreach ($entry in $files) { $entry.Hash = Get-MigrationHash $entry.Stream }
        # Reject newly appeared/disappeared sidecars before doing any writes.
        Assert-MigrationSourceSet $source $files
        $candidate = Join-Path $parent ('.envdock-migration-' + [guid]::NewGuid().ToString('N'))
        [void](Assert-MigrationPath $candidate)
        if ($null -ne (Get-MigrationAttributes $candidate)) { throw 'Staging directory already exists.' }
        [void][IO.Directory]::CreateDirectory($candidate)
        $work = $candidate
        # Set a private ACL BEFORE writing any source bytes.
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $work -AclObject $acl
        $backup = Join-Path $work 'backup'
        $payload = Join-Path $work 'payload'
        [void][IO.Directory]::CreateDirectory($backup)
        [void][IO.Directory]::CreateDirectory($payload)
        foreach ($entry in $files) {
            $path = Join-Path $backup $entry.Name
            Copy-MigrationStream $entry.Stream $path
            Assert-MigrationHash $path $entry.Hash
        }
        foreach ($entry in $files) {
            $path = Join-Path $payload $entry.Name
            Copy-MigrationStream $entry.Stream $path
            Assert-MigrationHash $path $entry.Hash
        }
        Assert-MigrationStopped
        Assert-MigrationSourceSet $source $files
        Assert-MigrationTarget $destination
        if (-not [IO.Directory]::Exists($destination)) {
            [void][IO.Directory]::CreateDirectory($destination)
            $createdDestination = $true
        }
        $result = [pscustomobject]@{
            SourceDirectory = $source
            DestinationDirectory = $destination
            BackupDirectory = $backup
            HistoricalBackups = 'Not copied; retained unchanged in source\backups.'
            WindowsUserSid = $sid.Value
        }
        foreach ($entry in $files | Where-Object { $_.Name -ne 'app.db' }) {
            $target = Join-Path $destination $entry.Name
            Move-MigrationFile (Join-Path $payload $entry.Name) $target
            $published.Add([pscustomobject]@{ Path = $target; Hash = $entry.Hash })
        }
        Assert-MigrationStopped
        Assert-MigrationSourceSet $source $files
        Assert-MigrationTarget $destination $published
        # Last fallible publication step; a partial app.db is never exposed.
        Move-MigrationFile (Join-Path $payload 'app.db') (Join-Path $destination 'app.db')
        $committed = $true
        return $result
    } finally {
        # Only remove files that THIS invocation published. Never recursively
        # delete/move directories, never delete a source or pre-existing file.
        if (-not $committed) {
            foreach ($entry in $published) {
                try {
                    [void](Assert-MigrationPath $entry.Path)
                    Assert-MigrationHash $entry.Path $entry.Hash
                    [IO.File]::Delete($entry.Path)
                } catch { Write-Warning "Could not safely roll back sidecar: $($entry.Path). $_" }
            }
            if ($createdDestination) {
                try {
                    [void](Assert-MigrationPath $destination)
                    [IO.Directory]::Delete($destination, $false)
                } catch { Write-Warning "Destination retained for manual inspection: $destination" }
            }
        }
        if ($work) {
            try {
                [void](Assert-MigrationPath $work)
                $folders = @('payload')
                if (-not $committed) { $folders += 'backup' }
                foreach ($folder in $folders) {
                    $directory = Join-Path $work $folder
                    [void](Assert-MigrationPath $directory)
                    foreach ($name in @('app.db', 'app.db-wal', 'app.db-shm')) {
                        $path = Join-Path $directory $name
                        [void](Assert-MigrationPath $path)
                        if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
                    }
                    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $false) }
                }
                if (-not $committed) { [IO.Directory]::Delete($work, $false) }
            } catch { Write-Warning "Private staging/backup retained for manual inspection: $work. $_" }
        }
        foreach ($entry in $files) { $entry.Stream.Dispose() }
    }
}

# Test harness dot-sources definitions and overrides only process/IO boundaries.
# Normal CLI use always performs the real, fail-closed process detection.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-LocalDataMigration @PSBoundParameters
}
