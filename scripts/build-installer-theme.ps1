$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars32.bat'
if (-not (Test-Path -LiteralPath $vcvars)) {
    $vcvars = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Auxiliary\Build\vcvars32.bat'
}
if (-not $vcvars) { throw '安装器主题需要 MSVC x86 C++ Build Tools。' }
$output = Join-Path $root 'src-tauri\installer\plugins'
New-Item -ItemType Directory -Force -Path $output | Out-Null
# NSIS installer runs x86 even when it carries an x64 application.
$saved = @{}
Get-ChildItem Env: | ForEach-Object { $saved[$_.Name] = $_.Value }
try {
    $lines = & $env:ComSpec /d /c "`"$(@($vcvars)[0])`" >nul && set"
    if ($LASTEXITCODE) { throw '无法初始化 x86 编译环境。' }
    foreach ($line in $lines) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    & cl.exe /nologo /LD /O2 /MT /W4 /WX /EHsc (Join-Path $root 'src-tauri\installer\theme.cpp') "/Fo$output\theme.obj" /link "/OUT:$output\EnvDockTheme.dll" "/IMPLIB:$output\EnvDockTheme.lib" user32.lib gdi32.lib comctl32.lib uxtheme.lib dwmapi.lib
    if ($LASTEXITCODE) { throw '安装器深色主题编译失败。' }
} finally {
    Get-ChildItem Env: | Where-Object { -not $saved.ContainsKey($_.Name) } | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name,$null,'Process') }
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
}
