# Windows PowerShell 5.1. Dot-source to expose the workflow and effect seams without running it.
# Caller: nsExec::ExecToLog WITHOUT /TIMEOUT; -WorkDirectory must be its private $PLUGINSDIR.
# Download sources verified against tauri-apps/tauri crates/tauri-bundler/src/bundle/windows/util.rs.
# Detection/install contract: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
param(
    [string]$WorkDirectory,
    [ValidateSet('zh-CN', 'en-US')][string]$Language = 'zh-CN'
)

function Write-WebView2Log {
    param([string]$Phase, [int]$Attempt = 0, [string]$Code = '0', [string]$Language = 'zh-CN')
    # Never log exception messages, paths, proxy credentials, or redirect URLs.
    $label = if ($Language -eq 'zh-CN') { 'WebView2 依赖' } else { 'WebView2 dependency' }
    Write-Host "[$label] phase=$Phase attempt=$Attempt code=$Code"
}

function Get-WebView2RegistryValue {
    param([Microsoft.Win32.RegistryHive]$Hive, [Microsoft.Win32.RegistryView]$View)
    $base = $null; $key = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', $false)
        if ($null -ne $key -and $key.GetValueKind('pv') -eq [Microsoft.Win32.RegistryValueKind]::String) {
            return $key.GetValue('pv', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
    } catch { return $null }
    finally {
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
}

function Test-WebView2Installed {
    foreach ($hive in @('LocalMachine', 'CurrentUser')) {
        foreach ($view in @('Registry32', 'Registry64')) {
            try {
                $pv = Get-WebView2RegistryValue -Hive $hive -View $view
                if ($pv -isnot [string] -or $pv -notmatch '^\d+\.\d+\.\d+\.\d+$') { continue }
                $version = $null
                if ([version]::TryParse($pv, [ref]$version) -and $version -gt [version]'0.0.0.0') { return $true }
            } catch { continue }
        }
    }
    return $false
}

function Get-WebView2AuthenticodeSignature {
    param([string]$Path)
    Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
}

function Read-WebView2DerElement {
    param([byte[]]$Data, [int]$Offset, [int]$Limit)
    if ($Offset + 2 -gt $Limit) { throw 'Invalid distinguished name.' }
    $tag = [int]$Data[$Offset]; $Offset++
    $length = [int]$Data[$Offset]; $Offset++
    if ($length -band 128) {
        $count = $length -band 127; $length = 0
        if ($count -lt 1 -or $count -gt 4 -or $Offset + $count -gt $Limit) { throw 'Invalid DER length.' }
        for ($i = 0; $i -lt $count; $i++) {
            $length = $length * 256 + [int]$Data[$Offset]; $Offset++
        }
    }
    if ($length -lt 0 -or $Offset + $length -gt $Limit) { throw 'Invalid DER boundary.' }
    return [pscustomobject]@{ Tag = $tag; Start = $Offset; Length = $length; End = ($Offset + $length) }
}

function Test-WebView2MicrosoftSignature {
    param([string]$Path)
    try {
        $signature = Get-WebView2AuthenticodeSignature -Path $Path
        if ([string]$signature.Status -cne 'Valid' -or $null -eq $signature.SignerCertificate) { return $false }
        # Parse the X.500 DER organization OID (2.5.4.10), not a substring of Subject/CN.
        # This avoids quoted/escaped CN text spoofing an O=Microsoft Corporation field.
        [byte[]]$data = $signature.SignerCertificate.SubjectName.RawData
        $name = Read-WebView2DerElement $data 0 $data.Length
        if ($name.Tag -ne 48 -or $name.End -ne $data.Length) { return $false }
        $organizations = @()
        $position = $name.Start
        while ($position -lt $name.End) {
            $rdn = Read-WebView2DerElement $data $position $name.End
            if ($rdn.Tag -ne 49) { return $false }
            $attributePosition = $rdn.Start
            while ($attributePosition -lt $rdn.End) {
                $attribute = Read-WebView2DerElement $data $attributePosition $rdn.End
                if ($attribute.Tag -ne 48) { return $false }
                $oid = Read-WebView2DerElement $data $attribute.Start $attribute.End
                if ($oid.Tag -ne 6) { return $false }
                $value = Read-WebView2DerElement $data $oid.End $attribute.End
                if ($value.End -ne $attribute.End) { return $false }
                if ($oid.Length -eq 3 -and $data[$oid.Start] -eq 85 -and
                    $data[$oid.Start + 1] -eq 4 -and $data[$oid.Start + 2] -eq 10) {
                    if ($value.Tag -eq 30) {
                        $organization = [Text.Encoding]::BigEndianUnicode.GetString($data, $value.Start, $value.Length)
                    } elseif ($value.Tag -in @(12, 19, 20, 22)) {
                        $organization = (New-Object Text.UTF8Encoding($false, $true)).GetString($data, $value.Start, $value.Length)
                    } else { return $false }
                    $organizations += $organization
                }
                $attributePosition = $attribute.End
            }
            $position = $rdn.End
        }
        return ($organizations.Count -eq 1 -and $organizations[0] -ceq 'Microsoft Corporation')
    } catch { return $false }
}

function Get-WebView2PathAttributes {
    param([string]$Path)
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-WebView2SafePath {
    param([string]$Path)
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2) -match '[:\x00-\x1f"]') {
        throw 'Only absolute local filesystem paths are allowed.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $ancestors = New-Object 'System.Collections.Generic.List[string]'
    $current = $full
    while ($current) {
        $ancestors.Insert(0, $current)
        $current = [IO.Path]::GetDirectoryName($current)
    }
    # Walk from the drive root before traversing any potential junction.
    foreach ($ancestor in $ancestors) {
        $attributes = Get-WebView2PathAttributes -Path $ancestor
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Reparse destination refused.'
        }
    }
}

function New-WebView2Directory {
    param([string]$Path)
    [void][IO.Directory]::CreateDirectory($Path)
}

function New-WebView2AttemptDirectory {
    param([string]$WorkDirectory)
    Assert-WebView2SafePath -Path $WorkDirectory
    $full = [IO.Path]::GetFullPath($WorkDirectory).TrimEnd('\')
    $attributes = Get-WebView2PathAttributes -Path $full
    if ($full.Length -le 3 -or $null -eq $attributes -or
        -not ($attributes -band [IO.FileAttributes]::Directory)) { throw 'Private work directory is required.' }
    $directory = Join-Path $full ('webview2-' + [guid]::NewGuid().ToString('N'))
    if ($null -ne (Get-WebView2PathAttributes -Path $directory)) { throw 'Attempt directory already exists.' }
    New-WebView2Directory -Path $directory
    Assert-WebView2SafePath -Path $directory
    return $directory
}

function New-WebView2HttpRequest {
    param([uri]$Uri, [int]$TimeoutMilliseconds)
    if ($Uri.Scheme -cne 'https' -or $Uri.UserInfo) { throw 'HTTPS without user information required.' }
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.Proxy = [Net.WebRequest]::GetSystemWebProxy()
    if ($null -ne $request.Proxy) { $request.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
    return $request
}

function Get-WebView2RemainingMilliseconds {
    param([Diagnostics.Stopwatch]$Clock, [int]$TimeoutSeconds)
    $remaining = [long]$TimeoutSeconds * 1000 - $Clock.ElapsedMilliseconds
    if ($remaining -le 0) { throw (New-Object TimeoutException('Download deadline exceeded.')) }
    return [int]$remaining
}

function Invoke-WebView2Download {
    param([uri]$Uri, [string]$Destination, [ValidateRange(1, 1800)][int]$TimeoutSeconds = 120)
    Assert-WebView2SafePath -Path $Destination
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    $request = $null; $response = $null; $inputStream = $null; $outputStream = $null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $current = $Uri
        for ($redirect = 0; $redirect -le 10; $redirect++) {
            if ($current.Scheme -cne 'https' -or $current.UserInfo) { throw 'Unsafe redirect refused.' }
            $remaining = Get-WebView2RemainingMilliseconds $clock $TimeoutSeconds
            $request = New-WebView2HttpRequest -Uri $current -TimeoutMilliseconds $remaining
            $pending = $request.BeginGetResponse($null, $null)
            $wait = $pending.AsyncWaitHandle
            try {
                if (-not $wait.WaitOne((Get-WebView2RemainingMilliseconds $clock $TimeoutSeconds))) {
                    throw (New-Object TimeoutException('Download response deadline exceeded.'))
                }
                $response = $request.EndGetResponse($pending)
            } finally { $wait.Close() }
            if ($response.ResponseUri.Scheme -cne 'https') { throw 'Final response must use HTTPS.' }
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                if ($redirect -eq 10 -or -not $response.Headers['Location']) { throw 'Redirect limit or missing location.' }
                $current = New-Object uri($current, $response.Headers['Location'])
                $response.Close(); $response = $null
                continue
            }
            if ($status -ne 200) { throw 'Download HTTP status rejected.' }
            Assert-WebView2SafePath -Path $Destination
            $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $response.GetResponseStream()
            $buffer = New-Object byte[] 65536
            $total = 0L
            while ($true) {
                $pending = $inputStream.BeginRead($buffer, 0, $buffer.Length, $null, $null)
                $wait = $pending.AsyncWaitHandle
                try {
                    if (-not $wait.WaitOne((Get-WebView2RemainingMilliseconds $clock $TimeoutSeconds))) {
                        throw (New-Object TimeoutException('Download body deadline exceeded.'))
                    }
                    $count = $inputStream.EndRead($pending)
                } finally { $wait.Close() }
                if ($count -eq 0) { break }
                $total += $count
                if ($total -gt 1GB) { throw 'Download size limit exceeded.' }
                $outputStream.Write($buffer, 0, $count)
            }
            if ($total -eq 0) { throw 'Empty download refused.' }
            return
        }
    } catch [Net.WebException] {
        if ($_.Exception.Status -eq [Net.WebExceptionStatus]::Timeout) {
            throw (New-Object TimeoutException('Network deadline exceeded.'))
        }
        throw
    } finally {
        if ($null -ne $request) { $request.Abort() }
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $outputStream) { $outputStream.Dispose() }
        if ($null -ne $response) { $response.Close() }
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        $clock.Stop()
    }
}

function New-WebView2InstallerProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $StartInfo
    return $process
}

function Invoke-WebView2Installer {
    param([string]$Path, [ValidateRange(1, 1800)][int]$TimeoutSeconds = 300)
    Assert-WebView2SafePath -Path $Path
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = '"' + $Path + '"'
    $info.Arguments = '/silent /install'
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($Path)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $process = New-WebView2InstallerProcess -StartInfo $info
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Installer did not start.' }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            return [pscustomobject]@{ TimedOut = $true; ExitCode = 1460 }
        }
        return [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode }
    } catch {
        # If monitoring failed after Start, another installer must not be launched.
        if ($started) { return [pscustomobject]@{ TimedOut = $true; ExitCode = 1460 } }
        throw
    } finally {
        # Dispose releases this handle only; NEVER Kill the shared Runtime installer.
        $process.Dispose()
    }
}

function Invoke-EnsureWebView2 {
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$WorkDirectory,
        [ValidateSet('zh-CN', 'en-US')][string]$Language = 'zh-CN'
    )
    Write-WebView2Log -Phase detect -Language $Language
    if (Test-WebView2Installed) {
        Write-WebView2Log -Phase installed -Language $Language
        return 0
    }
    $sources = @(
        'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
        'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
        'https://go.microsoft.com/fwlink/?linkid=2124701',
        'https://go.microsoft.com/fwlink/?linkid=2124701'
    )
    for ($index = 0; $index -lt $sources.Count; $index++) {
        $attempt = $index + 1
        $phase = 'prepare'
        try {
            $directory = New-WebView2AttemptDirectory -WorkDirectory $WorkDirectory
            $path = Join-Path $directory 'MicrosoftWebView2Setup.exe'
            $phase = if ($index -lt 2) { 'download-bootstrap' } else { 'download-standalone-x64' }
            Write-WebView2Log -Phase $phase -Attempt $attempt -Language $Language
            $downloadTimeout = if ($index -lt 2) { 120 } else { 600 }
            Invoke-WebView2Download -Uri $sources[$index] -Destination $path -TimeoutSeconds $downloadTimeout
            $phase = 'signature'
            if (-not (Test-WebView2MicrosoftSignature -Path $path)) {
                Write-WebView2Log -Phase $phase -Attempt $attempt -Code invalid -Language $Language
                continue
            }
        } catch [TimeoutException] {
            # No installer has started: network timeouts may safely retry/fall back.
            Write-WebView2Log -Phase $phase -Attempt $attempt -Code download-timeout -Language $Language
            continue
        } catch {
            Write-WebView2Log -Phase $phase -Attempt $attempt -Code failed -Language $Language
            if ($phase -eq 'prepare') { return 1 }
            continue
        }
        Write-WebView2Log -Phase install -Attempt $attempt -Language $Language
        $result = $null
        try {
            $result = Invoke-WebView2Installer -Path $path -TimeoutSeconds 300
            Write-WebView2Log -Phase install-exit -Attempt $attempt -Code ([string]$result.ExitCode) -Language $Language
        } catch {
            Write-WebView2Log -Phase install-exception -Attempt $attempt -Code failed -Language $Language
        }
        # Always redetect, including start failures, nonzero exits, reboot and timeout.
        $installed = Test-WebView2Installed
        Write-WebView2Log -Phase redetect -Attempt $attempt -Code ([int]$installed) -Language $Language
        if ($null -ne $result -and $result.TimedOut) { return 1460 }
        if ($installed) { return 0 }
        if ($null -ne $result -and $result.ExitCode -in @(3010, 1641)) {
            Write-WebView2Log -Phase reboot-required -Attempt $attempt -Code 3010 -Language $Language
            return 3010
        }
        # Leave only this attempt's files in the caller-owned private directory.
        # No recursive/profile cleanup and no deletion of possibly-running installers.
    }
    Write-WebView2Log -Phase exhausted -Attempt 4 -Code 1 -Language $Language
    return 1
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($args.Count -ne 0 -or [string]::IsNullOrWhiteSpace($WorkDirectory)) {
        Write-WebView2Log -Phase arguments -Code 1 -Language $Language
        exit 1
    }
    try { exit (Invoke-EnsureWebView2 -WorkDirectory $WorkDirectory -Language $Language) }
    catch {
        Write-WebView2Log -Phase unexpected -Code 1 -Language $Language
        exit 1
    }
}
