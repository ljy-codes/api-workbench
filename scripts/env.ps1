$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$localCargo = Join-Path $root '.tools\cargo'
$localRustup = Join-Path $root '.tools\rustup'
if ((Test-Path -LiteralPath "$localCargo\bin\cargo.exe") -and (Test-Path -LiteralPath "$localRustup\toolchains")) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = $localRustup
    $env:PATH = "$localCargo\bin;$env:PATH"
} elseif (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw '未找到 Rust。请安装 Rust MSVC 工具链，重新打开终端后重试。'
}
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $candidate = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Auxiliary\Build\vcvars64.bat'
        if ($candidate) { $vcvars = @($candidate)[0] }
    }
    if (-not (Test-Path -LiteralPath $vcvars)) {
        throw '未找到 MSVC C++ Build Tools。请安装 Windows C++ 工具链和 Windows SDK 后运行。'
    }
}
$environment = & $env:ComSpec /d /c "`"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'MSVC 环境初始化失败。' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
