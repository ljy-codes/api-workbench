<#
.SYNOPSIS
Explicit, bounded EnvDock user-data cleanup for Windows PowerShell 5.1.
.DESCRIPTION
No -Purge: no filesystem access or cleanup; exit 0.
-Purge: remove ONLY ApiWorkbench under LocalApplicationData, and
local.apiworkbench.desktop under LocalApplicationData and ApplicationData.
Production roots come from .NET special folders for the executing user, NEVER
from command-line roots or ambient LOCALAPPDATA/APPDATA environment variables.
Run as the original interactive user (not SYSTEM/another elevated account).

Close all app/WebView instances first. Every target is preflighted before any
deletion: strict local canonical paths, no ancestor/descendant reparse points,
directory types, read-only files, enumeration errors, and exclusive file opens.
File handles stay open throughout preflight and until each file's deletion.
No file contents, credentials, or child filenames are logged. Errors report
remaining app-owned ROOT paths; exit 1 tells NSIS to abort before binary removal.

Deletion is NOT transactional. ACL/delete permission errors or concurrent
changes after preflight can leave partially removed data; retry only after
closing the app and inspecting the reported roots. Exclusive opens detect
ordinary locked files, not every possible mapped-file/delete-permission issue.
Path rechecks + nonrecursive deletes reduce but DO NOT eliminate TOCTOU races.
This is not a security boundary against hostile concurrent path/ACL replacement.
No recursive delete API is used; new children cause a nonempty-directory error.

Portable data, Yaak, manual exports, shared WebView2, and sibling migration
backups are NOT targets. Normal nested DB backups and framework caches inside
the three owned directories ARE deleted when explicitly purging.
Dot-sourcing defines functions only (even with -Purge). Synthetic tests inject
both special-folder roots at the function boundary, never at the script CLI.
.EXAMPLE
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File uninstall-data.ps1 -Purge
#>
[CmdletBinding()]
param([switch]$Purge)

function Get-UninstallDataRoots {
    return @{
        LocalApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        ApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    }
}

function Get-UninstallDataAttributes([string]$Path) {
    # Exists() suppresses access errors and can misclassify dangling links.
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-UninstallCanonicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -cnotmatch '^[A-Za-z]:\\') {
        throw 'An absolute local drive path is required.'
    }
    if ($Path.Length -le 3 -or $Path.Substring(2) -match '[:/*?"<>|~]' -or $Path -match '[\x00-\x1f]') {
        throw 'Root, device, wildcard, stream or alias path refused.'
    }
    foreach ($part in ($Path.Substring(3) -split '\\')) {
        if ([string]::IsNullOrEmpty($part) -or $part -in @('.', '..') -or
            $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') {
            throw 'Noncanonical path component refused.'
        }
    }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path normalization would change the target.'
    }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)) {
        throw 'Only local fixed/removable drives are allowed.'
    }
    return $full
}

function Assert-UninstallNoReparse([string]$Path) {
    $chain = New-Object 'System.Collections.Generic.List[string]'
    $current = $Path
    while ($current) {
        $chain.Insert(0, $current)
        $current = [IO.Path]::GetDirectoryName($current)
    }
    $leaf = $null
    # Drive -> parent -> leaf: never first stat a child through an unchecked link.
    foreach ($part in $chain) {
        $attributes = Get-UninstallDataAttributes $part
        if ($null -ne $attributes) {
            if (($attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Reparse point refused.'
            }
            if ($part -ne $Path -and -not ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'Ancestor is not a directory.'
            }
        }
        $leaf = $attributes
    }
    return $leaf
}

function Assert-UninstallOwnedPath([string]$Path, [string]$Root) {
    $full = Assert-UninstallCanonicalPath $Path
    if (-not $full.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path escaped the owned root.'
    }
    return (Assert-UninstallNoReparse $full)
}

function Invoke-UninstallDataCleanup {
    [CmdletBinding()]
    param(
        [switch]$Purge,
        [string]$LocalApplicationData,
        [string]$ApplicationData
    )
    if (-not $Purge) { return }
    $ErrorActionPreference = 'Stop'
    $targets = @()
    $files = New-Object 'System.Collections.Generic.List[object]'
    $directories = New-Object 'System.Collections.Generic.List[object]'
    $stage = 'path validation'
    try {
        $hasLocal = $PSBoundParameters.ContainsKey('LocalApplicationData')
        $hasRoaming = $PSBoundParameters.ContainsKey('ApplicationData')
        if ($hasLocal -ne $hasRoaming) { throw 'Inject both roots or neither.' }
        if (-not $hasLocal) {
            $roots = Get-UninstallDataRoots
            $LocalApplicationData = $roots.LocalApplicationData
            $ApplicationData = $roots.ApplicationData
        }
        $local = Assert-UninstallCanonicalPath $LocalApplicationData
        $roaming = Assert-UninstallCanonicalPath $ApplicationData
        if ($local.Equals($roaming, [StringComparison]::OrdinalIgnoreCase) -or
            $local.StartsWith($roaming + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $roaming.StartsWith($local + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Special-folder roots must be distinct and non-nested.'
        }
        # Fixed allowlist, never glob siblings or accept arbitrary target names.
        $targets = @(
            [IO.Path]::Combine($local, 'ApiWorkbench')
            [IO.Path]::Combine($local, 'local.apiworkbench.desktop')
            [IO.Path]::Combine($roaming, 'local.apiworkbench.desktop')
        )
        $stage = 'preflight'
        foreach ($target in $targets) {
            $attributes = Assert-UninstallOwnedPath $target $target
            if ($null -eq $attributes) { continue }
            if (-not ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'Owned root is not a directory.'
            }
            $pending = New-Object 'System.Collections.Generic.Stack[string]'
            $pending.Push($target)
            while ($pending.Count -gt 0) {
                $directory = $pending.Pop()
                $attributes = Assert-UninstallOwnedPath $directory $target
                if ($null -eq $attributes -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
                    throw 'Directory changed during preflight.'
                }
                $directories.Add([pscustomobject]@{ Path = $directory; Root = $target })
                # Single-level enumeration, including hidden/system children.
                foreach ($child in [IO.Directory]::GetFileSystemEntries($directory)) {
                    $attributes = Assert-UninstallOwnedPath $child $target
                    if ($null -eq $attributes) { throw 'Child disappeared during preflight.' }
                    if (($attributes -band [IO.FileAttributes]::Directory)) {
                        $pending.Push($child)
                    } else {
                        if (($attributes -band [IO.FileAttributes]::ReadOnly)) {
                            throw 'Read-only file refused.'
                        }
                        $stream = [IO.File]::Open($child, [IO.FileMode]::Open,
                            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                        $files.Add([pscustomobject]@{ Path = $child; Root = $target; Stream = $stream })
                    }
                }
            }
        }
        # All three roots have passed preflight; no deletion occurs above here.
        $stage = 'deletion'
        foreach ($file in $files) {
            $attributes = Assert-UninstallOwnedPath $file.Path $file.Root
            if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'File changed since preflight.'
            }
            $file.Stream.Dispose()
            $file.Stream = $null
            # Recheck after releasing this handle, immediately before deletion.
            $attributes = Assert-UninstallOwnedPath $file.Path $file.Root
            if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'File changed before deletion.'
            }
            [IO.File]::Delete($file.Path)
            if ($null -ne (Assert-UninstallOwnedPath $file.Path $file.Root)) {
                throw 'File remains after deletion.'
            }
        }
        # Children first; false explicitly forbids recursive directory deletion.
        for ($index = $directories.Count - 1; $index -ge 0; $index--) {
            $entry = $directories[$index]
            $attributes = Assert-UninstallOwnedPath $entry.Path $entry.Root
            if ($null -eq $attributes -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'Directory changed since preflight.'
            }
            [IO.Directory]::Delete($entry.Path, $false)
        }
        foreach ($target in $targets) {
            if ($null -ne (Assert-UninstallOwnedPath $target $target)) {
                throw 'Owned root remains after deletion.'
            }
        }
    } catch {
        # Do not echo exception text, child names, data contents, or injected roots.
        # Roots here have passed lexical validation and contain fixed app names.
        $remaining = @(
            foreach ($target in $targets) {
                try {
                    if ($null -ne (Assert-UninstallOwnedPath $target $target)) { $target }
                } catch { $target } # Unverifiable == remaining, never success.
            }
        )
        if ($remaining.Count -eq 0) {
            $remaining = @('<unresolved or changed app-owned roots; verify before retry>')
        }
        throw ("EnvDock cleanup failed during {0}. Remaining path(s): {1}. Close the app and inspect permissions/links before retrying." -f
            $stage, ($remaining -join '; '))
    } finally {
        foreach ($file in $files) {
            if ($null -ne $file.Stream) { $file.Stream.Dispose() }
        }
    }
}

function Invoke-UninstallDataMain {
    [CmdletBinding()]
    param([switch]$Purge)
    try {
        Invoke-UninstallDataCleanup -Purge:$Purge
        return 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        return 1
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-UninstallDataMain -Purge:$Purge)
}
