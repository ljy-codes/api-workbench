# 安装器依赖自修复 Implementation Plan

**Goal:** 安装时自动检测与补齐运行依赖，尽力下载/安装后才报错；用户授权覆盖现有 v1.0.0。

**Architecture:** NSIS 负责进度、重试入口和旧版保护；独立 PowerShell 5.1 脚本负责 WebView2 检测、官方 HTTPS 下载、Microsoft Authenticode 校验、静默安装及重新检测。业务程序、数据格式和卸载清理逻辑保持不变。

**Tech Stack:** NSIS 3、Windows PowerShell 5.1、Microsoft WebView2 Evergreen、GitHub Release API。

## 已确认与范围

- 用户于 2026-10-04 批准按需下载、自动重试、官方备用安装方式、验签、重新检测和保护旧版；继续使用 1.0.0 并替换现有 Release。
- 现有模板只尝试一次下载，且更新模式跳过缺失依赖；交互升级在依赖检测前卸载旧程序。
- PE 依赖检查确认主程序不动态依赖 VCRUNTIME/MSVCP，主题插件使用 /MT；不下载 Node/Rust/SDK 等开发工具。受支持 Windows 的系统组件损坏不当作可任意下载 DLL 处理。
- WebView2 按微软文档检查 HKLM/HKCU、32/64 位注册视图，有效 pv 必须大于 0.0.0.0；不把 Edge 浏览器本身当 Runtime。
- 首选微软 bootstrapper，两次有界尝试；失败后微软 x64 Evergreen standalone，两次有界尝试。网络代理用系统设置，TLS 校验不关闭。
- 仅运行签名有效且签发给 Microsoft Corporation 的下载 EXE；每次执行后重新检测，不能仅凭 exit 0 宣告成功。重启要求和超时单独报告，不叠加安装进程。
- 自动修复失败后：交互模式允许重试、打开微软手动安装页后重新检测或退出；静默/被动模式返回非零，不弹隐藏对话框。
- 本机已有 Runtime，不卸载它；缺失、重试、签名失败及安装错误使用隔离合成测试。

## 文件与执行步骤

- [x] `scripts/ensure-webview2.ps1` + `scripts/test-ensure-webview2.ps1`：先失败测试，再实现独立有界状态机；测试注入模拟下载/签名/进程/注册读，不执行真实安装。
- [x] `src-tauri/installer/dependencies.nsh` + `envdock.nsi` + `messages.nsh`：接入 ExecToLog；把升级卸载延迟到依赖成功后；重试不再次误删程序；保留用户主动卸载原流程。
- [x] `scripts/test-packaging.mjs` + NSIS 隔离夹具：验证交互/静默失败不落入程序写入；升级保留原程序；新安装、升级、已有依赖均进入检测。
- [x] 运行 PowerShell 5.1、前端/原生全测，NSIS 实际编译；独立代码评审。重新构建实际安装包并保留旧附件本地备份。
- [x] 更新 README/公开测试摘要/版本说明、SHA256，交付产品按原 1.0.0 路径替换。
- [ ] 精确提交（排除本机 docs/test.md 私密记录）；推送 main；仅对授权的 v1.0.0 标签与附件更新，保留同一个 Release。远端附件校验并公开下载复验。

## 验证与风险

- 完整依赖下载需要联网，无法绕过企业安全策略、用户拒绝授权或系统不受支持；失败给出可操作提示。
- 安装返回 3010/1641 但检测未就绪时提示重启；超时不杀系统安装进程、不无限重试。
- 同版本替换使原 checksum 失效：明确标注 2026-10-04 安装修订和新 checksum。不覆盖本机私有数据，不卸载共享 Runtime。

## 源码冻结时状态

611 项自动化测试、24 项真实安装断言、fmt/clippy 与安装包构建均通过。独立评审无新增 P1/P2；交付文件及新 SHA256 已核对。最后一项为源码提交后的发布动作，结果由 GitHub Release 及本机发布回执确认。
