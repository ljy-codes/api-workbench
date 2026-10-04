# Synthetic-only tests; Windows PowerShell 5.1, no Pester, downloads, installs or registry writes.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$implementation = Join-Path $PSScriptRoot 'ensure-webview2.ps1'
$script:passed = 0
$script:failed = 0
function Assert-Equal($Expected, $Actual, [string]$Message = '') {
    if ($Expected -cne $Actual) { throw "$Message expected=[$Expected] actual=[$Actual]" }
}
function Assert-True($Actual, [string]$Message = '') {
    if (-not $Actual) { throw "Assertion failed: $Message" }
}
function Assert-Throws([scriptblock]$Action) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert-True $threw 'must reject unsafe input'
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Host "PASS $Name" }
    catch { $script:failed++; Write-Host "FAIL $Name : $($_.Exception.Message)" }
}

Test-Case 'helper exists (TDD initial red)' {
    Assert-True (Test-Path -LiteralPath $implementation) 'ensure-webview2.ps1 is not implemented yet'
}
if (-not (Test-Path -LiteralPath $implementation)) { exit 1 }

# Load into this scope. Safety tripwires also prove dot-sourcing does not invoke any effect.
function Invoke-EnsureWebView2 { throw 'dot-source ran workflow' }
$beforePreference = $ErrorActionPreference
$importOutput = @(. $implementation)
Test-Case 'dot-source produces no output and preserves preferences' {
    Assert-Equal 0 $importOutput.Count
    Assert-Equal $beforePreference $ErrorActionPreference
}
$script:original = @{}
foreach ($name in @('Get-WebView2RegistryValue', 'Test-WebView2Installed',
    'Get-WebView2AuthenticodeSignature', 'Test-WebView2MicrosoftSignature',
    'Get-WebView2PathAttributes', 'New-WebView2Directory', 'New-WebView2AttemptDirectory',
    'Assert-WebView2SafePath', 'Invoke-WebView2Download', 'Invoke-WebView2Installer',
    'New-WebView2InstallerProcess', 'Write-WebView2Log')) {
    $script:original[$name] = (Get-Item "function:$name").ScriptBlock
}
function Reset-Seams {
    foreach ($name in $script:original.Keys) {
        Set-Item "function:script:$name" $script:original[$name]
    }
    $script:state = @{
        DetectionCalls = 0; InstalledAfter = 999; Downloads = @(); Executions = 0
        DirectoryCalls = 0; DownloadFailures = 0; Signature = $true; DownloadTimeouts = @()
        ExitCode = 0; TimedOut = $false; InstallThrows = $false; Logs = @()
    }
    function script:Test-WebView2Installed {
        $script:state.DetectionCalls++
        return ($script:state.DetectionCalls -ge $script:state.InstalledAfter)
    }
    function script:New-WebView2AttemptDirectory($WorkDirectory) {
        $script:state.DirectoryCalls++
        return "$WorkDirectory\attempt-$($script:state.DirectoryCalls)"
    }
    function script:Invoke-WebView2Download($Uri, $Destination, $TimeoutSeconds) {
        $script:state.Downloads += [string]$Uri
        $script:state.DownloadTimeouts += $TimeoutSeconds
        if ($script:state.Downloads.Count -le $script:state.DownloadFailures) {
            throw 'synthetic network error https://secret.example/?token=DO-NOT-LOG'
        }
    }
    function script:Test-WebView2MicrosoftSignature($Path) { return $script:state.Signature }
    function script:Invoke-WebView2Installer($Path, $TimeoutSeconds) {
        $script:state.Executions++
        if ($script:state.InstallThrows) { throw 'synthetic start failure secret-user-path' }
        return [pscustomobject]@{ ExitCode = $script:state.ExitCode; TimedOut = $script:state.TimedOut }
    }
    function script:Write-WebView2Log($Phase, $Attempt, $Code, $Language) {
        $script:state.Logs += "$Phase/$Attempt/$Code"
    }
}
function Run-Workflow { Invoke-EnsureWebView2 -WorkDirectory 'C:\synthetic private\NSIS' -Language en-US }

Test-Case 'already installed skips every effect' {
    Reset-Seams; $script:state.InstalledAfter = 1
    Assert-Equal 0 (Run-Workflow)
    Assert-Equal 0 $script:state.DirectoryCalls
    Assert-Equal 0 $script:state.Downloads.Count
    Assert-Equal 0 $script:state.Executions
}
Test-Case 'zero and malformed HKLM values fall through to HKCU explicit views' {
    Reset-Seams
    Set-Item function:Test-WebView2Installed $script:original['Test-WebView2Installed']
    $script:reads = @()
    function Get-WebView2RegistryValue($Hive, $View) {
        $script:reads += "$Hive/$View"
        switch ("$Hive/$View") {
            'LocalMachine/Registry32' { return '0.0.0.0' }
            'LocalMachine/Registry64' { return 'not-a-version' }
            'CurrentUser/Registry32' { return $null }
            'CurrentUser/Registry64' { return '130.0.2849.68' }
        }
    }
    Assert-True (Test-WebView2Installed)
    Assert-Equal 'LocalMachine/Registry32,LocalMachine/Registry64,CurrentUser/Registry32,CurrentUser/Registry64' ($script:reads -join ',')
}
Test-Case 'empty malformed non-string and all-zero pv are never installed' {
    Reset-Seams
    Set-Item function:Test-WebView2Installed $script:original['Test-WebView2Installed']
    foreach ($value in @($null, '', '0.0.0.0', '0.0', 'garbage', '1', '1.2', '1.2.3.4.5', '-1.2.3.4', 42)) {
        $script:pv = $value
        function Get-WebView2RegistryValue { return $script:pv }
        Assert-Equal $false (Test-WebView2Installed) "pv=$value"
    }
}
Test-Case 'unreadable registry view does not hide another view' {
    Reset-Seams
    Set-Item function:Test-WebView2Installed $script:original['Test-WebView2Installed']
    function Get-WebView2RegistryValue($Hive, $View) {
        if ($Hive -eq 'CurrentUser' -and $View -eq 'Registry64') { return '1.0.0.0' }
        throw 'synthetic access denied'
    }
    Assert-True (Test-WebView2Installed)
}
Test-Case 'Microsoft organization must match exactly and signature status must be Valid' {
    Reset-Seams
    Set-Item function:Test-WebView2MicrosoftSignature $script:original['Test-WebView2MicrosoftSignature']
    function Get-WebView2AuthenticodeSignature { return $script:signature }
    foreach ($case in @(
        @('Valid', 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US', $true),
        @('Valid', 'CN=Other, O="Microsoft Corporation", C=US', $true),
        @('Valid', 'CN=Microsoft Corporation, O=Other, C=US', $false),
        @('Valid', 'CN=Other, O=Microsoft Corporation Evil, C=US', $false),
        @('Valid', 'CN=Other, O=microsoft corporation, C=US', $false),
        @('Valid', 'CN="Fake, O=Microsoft Corporation", O=Other, C=US', $false),
        @('Valid', 'CN=Microsoft Corporation, OU=Microsoft Corporation, C=US', $false),
        @('Valid', 'O=Other, O=Microsoft Corporation, C=US', $false),
        @('NotTrusted', 'O=Microsoft Corporation, C=US', $false),
        @('HashMismatch', 'O=Microsoft Corporation, C=US', $false),
        @('NotSigned', 'O=Microsoft Corporation, C=US', $false)
    )) {
        $dn = New-Object Security.Cryptography.X509Certificates.X500DistinguishedName($case[1])
        $script:signature = [pscustomobject]@{
            Status = $case[0]; SignerCertificate = [pscustomobject]@{ SubjectName = $dn }
        }
        Assert-Equal $case[2] (Test-WebView2MicrosoftSignature 'C:\synthetic.exe') $case[1]
    }
    $script:signature = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = $null }
    Assert-Equal $false (Test-WebView2MicrosoftSignature 'C:\synthetic.exe')
}
Test-Case 'four bounded download failures use bootstrap twice then official x64 twice' {
    Reset-Seams; $script:state.DownloadFailures = 4
    Assert-Equal 1 (Run-Workflow)
    Assert-Equal 0 $script:state.Executions
    Assert-Equal 4 $script:state.DirectoryCalls
    Assert-Equal '120,120,600,600' ($script:state.DownloadTimeouts -join ',')
    Assert-Equal ('https://go.microsoft.com/fwlink/p/?LinkId=2124703,' * 2 +
        'https://go.microsoft.com/fwlink/?linkid=2124701,https://go.microsoft.com/fwlink/?linkid=2124701') ($script:state.Downloads -join ',')
    Assert-True (-not (($script:state.Logs -join ',') -match 'secret|token'))
}
Test-Case 'first download failure retries bootstrap and successful redetection returns zero' {
    Reset-Seams; $script:state.DownloadFailures = 1; $script:state.InstalledAfter = 2
    Assert-Equal 0 (Run-Workflow)
    Assert-Equal 2 $script:state.Downloads.Count
    Assert-Equal 1 $script:state.Executions
}
Test-Case 'fallback succeeds after both bootstrap downloads fail' {
    Reset-Seams; $script:state.DownloadFailures = 2; $script:state.InstalledAfter = 2
    Assert-Equal 0 (Run-Workflow)
    Assert-Equal 3 $script:state.Downloads.Count
    Assert-Equal 1 $script:state.Executions
}
Test-Case 'invalid signature never executes installer' {
    Reset-Seams; $script:state.Signature = $false
    Assert-Equal 1 (Run-Workflow)
    Assert-Equal 4 $script:state.Downloads.Count
    Assert-Equal 0 $script:state.Executions
}
Test-Case 'nonzero installer exit plus detected runtime is success' {
    Reset-Seams; $script:state.ExitCode = 1603; $script:state.InstalledAfter = 2
    Assert-Equal 0 (Run-Workflow)
    Assert-Equal 1 $script:state.Executions
}
Test-Case 'exit zero without detected runtime retries and eventually fails' {
    Reset-Seams
    Assert-Equal 1 (Run-Workflow)
    Assert-Equal 4 $script:state.Executions
    Assert-Equal 5 $script:state.DetectionCalls
}
Test-Case 'start exceptions always redetect and retry boundedly' {
    Reset-Seams; $script:state.InstallThrows = $true
    Assert-Equal 1 (Run-Workflow)
    Assert-Equal 4 $script:state.Executions
    Assert-Equal 5 $script:state.DetectionCalls
}
Test-Case 'start exception with independently installed runtime is success' {
    Reset-Seams; $script:state.InstallThrows = $true; $script:state.InstalledAfter = 2
    Assert-Equal 0 (Run-Workflow)
    Assert-Equal 1 $script:state.Executions
}
Test-Case 'process timeout redetects but stops all further attempts' {
    Reset-Seams; $script:state.TimedOut = $true
    Assert-Equal 1460 (Run-Workflow)
    Assert-Equal 1 $script:state.Executions
    Assert-Equal 1 $script:state.Downloads.Count
    Assert-Equal 2 $script:state.DetectionCalls
}
Test-Case 'timeout remains timeout even if runtime becomes visible' {
    Reset-Seams; $script:state.TimedOut = $true; $script:state.InstalledAfter = 2
    Assert-Equal 1460 (Run-Workflow)
    Assert-Equal 1 $script:state.Executions
}
Test-Case '3010 and 1641 without runtime require reboot with no continuation' {
    foreach ($code in @(3010, 1641)) {
        Reset-Seams; $script:state.ExitCode = $code
        Assert-Equal 3010 (Run-Workflow)
        Assert-Equal 1 $script:state.Executions
        Assert-Equal 2 $script:state.DetectionCalls
    }
}
Test-Case 'reboot exit with verified runtime can succeed' {
    Reset-Seams; $script:state.ExitCode = 3010; $script:state.InstalledAfter = 2
    Assert-Equal 0 (Run-Workflow)
}
Test-Case 'download deadline retries both official sources before reporting failure' {
    Reset-Seams
    function Invoke-WebView2Download { throw (New-Object TimeoutException('synthetic deadline')) }
    Assert-Equal 1 (Run-Workflow)
    Assert-Equal 4 $script:state.DirectoryCalls
    Assert-Equal 0 $script:state.Executions
}
Test-Case 'unique attempt directory and ancestor reparse rejection use only filesystem seams' {
    Reset-Seams
    Set-Item function:New-WebView2AttemptDirectory $script:original['New-WebView2AttemptDirectory']
    $script:created = @()
    function Get-WebView2PathAttributes($Path) {
        if ($Path -match 'webview2-[0-9a-f]{32}$') { return $null }
        return [IO.FileAttributes]::Directory
    }
    function New-WebView2Directory($Path) { $script:created += $Path }
    $first = New-WebView2AttemptDirectory 'C:\synthetic private\NSIS'
    $second = New-WebView2AttemptDirectory 'C:\synthetic private\NSIS'
    Assert-True ($first -ne $second)
    Assert-True ($first -match '^C:\\synthetic private\\NSIS\\webview2-[0-9a-f]{32}$')
    function Get-WebView2PathAttributes($Path) {
        if ($Path -eq 'C:\synthetic private') { return [IO.FileAttributes]::ReparsePoint }
        return [IO.FileAttributes]::Directory
    }
    Assert-Throws { New-WebView2AttemptDirectory 'C:\synthetic private\NSIS' }
    Assert-Equal 2 $script:created.Count
    Assert-Throws { New-WebView2AttemptDirectory '\\server\share\NSIS' }
    Assert-Throws { New-WebView2AttemptDirectory 'relative\NSIS' }
}
Test-Case 'installer uses quoted path no shell bounded wait and never kills' {
    Reset-Seams
    Set-Item function:Invoke-WebView2Installer $script:original['Invoke-WebView2Installer']
    function Assert-WebView2SafePath {}
    $script:waited = 0; $script:disposed = $false; $script:startInfo = $null
    function New-WebView2InstallerProcess($StartInfo) {
        $script:startInfo = $StartInfo
        $process = [pscustomobject]@{ ExitCode = 1603 }
        $process | Add-Member ScriptMethod Start { return $true }
        $process | Add-Member ScriptMethod WaitForExit { param($ms) $script:waited = $ms; return $true }
        $process | Add-Member ScriptMethod Dispose { $script:disposed = $true }
        $process | Add-Member ScriptMethod Kill { throw 'must never kill shared runtime installer' }
        return $process
    }
    $result = Invoke-WebView2Installer 'C:\synthetic private\setup.exe' -TimeoutSeconds 7
    Assert-Equal 1603 $result.ExitCode
    Assert-Equal $false $result.TimedOut
    Assert-Equal '"C:\synthetic private\setup.exe"' $script:startInfo.FileName
    Assert-Equal '/silent /install' $script:startInfo.Arguments
    Assert-Equal $false $script:startInfo.UseShellExecute
    Assert-Equal $true $script:startInfo.CreateNoWindow
    Assert-Equal 7000 $script:waited
    Assert-True $script:disposed
}
Test-Case 'installer timeout disposes handle without killing process' {
    Reset-Seams
    Set-Item function:Invoke-WebView2Installer $script:original['Invoke-WebView2Installer']
    function Assert-WebView2SafePath {}
    function New-WebView2InstallerProcess {
        $process = [pscustomobject]@{}
        $process | Add-Member ScriptMethod Start { return $true }
        $process | Add-Member ScriptMethod WaitForExit { return $false }
        $process | Add-Member ScriptMethod Dispose {}
        $process | Add-Member ScriptMethod Kill { throw 'forbidden kill' }
        return $process
    }
    Assert-True (Invoke-WebView2Installer 'C:\synthetic.exe' -TimeoutSeconds 1).TimedOut
}
Test-Case 'CLI declares only work directory and language; UTF8 BOM is present' {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($implementation, [ref]$tokens, [ref]$errors)
    Assert-Equal 0 $errors.Count
    Assert-Equal 'WorkDirectory,Language' (($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ',')
    foreach ($file in @($implementation, $PSCommandPath)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        Assert-Equal '239,187,191' ($bytes[0..2] -join ',')
    }
}
Write-Host "WebView2 synthetic tests: $script:passed passed, $script:failed failed."
if ($script:failed) { exit 1 }
exit 0
