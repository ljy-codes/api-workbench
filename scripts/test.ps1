$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '前端测试失败。' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    & cargo.exe test --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw '原生测试失败。' }
} finally { Pop-Location }
