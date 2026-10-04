$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & "$PSScriptRoot\build-installer-theme.ps1"
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $started = [DateTime]::UtcNow
    # No portable feature: installed builds retain the existing per-user data path.
    & npm.cmd exec -- tauri build --bundles nsis -- --locked
    if ($LASTEXITCODE -ne 0) { throw 'EnvDock 安装包构建失败。' }
    $bundle = Join-Path $root "src-tauri\target\release\bundle\nsis\EnvDock_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $bundle)) { throw "没有找到当前版本 x64 安装包：$bundle" }
    if ((Get-Item -LiteralPath $bundle).LastWriteTimeUtc -lt $started) { throw '安装包未在本次构建中更新，拒绝发布旧产物。' }
    $output = Join-Path $root "publish\EnvDock-$version-windows-x64"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    $name = "EnvDock-$version-windows-x64-setup.exe"
    Copy-Item -LiteralPath $bundle -Destination (Join-Path $output $name)
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $output '使用说明.md')
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $output 'LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $root 'scripts\migrate-local-data.ps1') -Destination $output
    Copy-Item -LiteralPath (Join-Path $root 'src-tauri\installer\TAURI-LICENSE-MIT') -Destination (Join-Path $output '第三方许可-Tauri.txt')
    $hash = (Get-FileHash -LiteralPath (Join-Path $output $name) -Algorithm SHA256).Hash
    "$hash  $name" | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
    Write-Output "EnvDock 安装包：$output"
} finally { Pop-Location }
