$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    & cargo.exe build --locked --manifest-path src-tauri/Cargo.toml --features portable,custom-protocol
    if ($LASTEXITCODE -ne 0) { throw '原生构建失败。' }
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $output = Join-Path $root "publish\接口工具-$version-preview"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'src-tauri\target\debug\api-workbench.exe') -Destination (Join-Path $output '接口工具.exe')
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $output '使用说明.md')
    $hash = (Get-FileHash -LiteralPath (Join-Path $output '接口工具.exe') -Algorithm SHA256).Hash
    "$hash  接口工具.exe" | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
    Write-Output "开发预览构建：$output"
} finally { Pop-Location }
