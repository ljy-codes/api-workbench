$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & npm.cmd run tauri -- dev
    if ($LASTEXITCODE -ne 0) { throw '桌面开发启动失败。' }
} finally { Pop-Location }
