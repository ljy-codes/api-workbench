$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '前端测试失败。' }
    & npm.cmd run test:packaging
    if ($LASTEXITCODE -ne 0) { throw '打包配置测试失败。' }
    & "$PSScriptRoot\test-migrate-local-data.ps1"
    if ($LASTEXITCODE -ne 0) { throw '数据迁移测试失败。' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-uninstall-data.ps1"
    if ($LASTEXITCODE -ne 0) { throw '卸载数据清理测试失败。' }
    & "$PSScriptRoot\test-installer-options.ps1"
    if ($LASTEXITCODE -ne 0) { throw '卸载参数解析测试失败。' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-uninstall-integration.ps1"
    if ($LASTEXITCODE -ne 0) { throw '隔离卸载集成测试失败。' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-ensure-webview2.ps1"
    if ($LASTEXITCODE -ne 0) { throw '依赖自动准备测试失败。' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-dependency-installer.ps1"
    if ($LASTEXITCODE -ne 0) { throw '安装器依赖链路测试失败。' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    & cargo.exe test --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw '原生测试失败。' }
} finally { Pop-Location }
