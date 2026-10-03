# EnvDock Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve the existing uncommitted 0.3 work.

**Goal:** 交付 EnvDock 0.3.0 当前用户 Windows x64 安装包，并保留便携版。

**Architecture:** 继续使用 Tauri 2 NSIS；只改变显示品牌和分发方式，不修改接口业务、SQLite schema 或 DPAPI。保留 `local.apiworkbench.desktop` 标识及 `%LOCALAPPDATA%\ApiWorkbench` 数据目录。安装包不内置项目、响应或凭据；迁移为退出程序后的显式操作，不覆盖目标数据。

**Tech Stack:** React/TypeScript/Vitest、Rust/Tauri 2、PowerShell、NSIS。

## Task 1 — 品牌和打包

Files: `src/App.tsx`, `src/App.test.tsx`, `index.html`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `scripts/build-installer.ps1`, `scripts/build-preview.ps1`, `scripts/test-packaging.mjs`.

- [x] 先加品牌断言 `expect(screen.getByText('EnvDock')).toBeTruthy()`；执行 `npm test -- --run src/App.test.tsx` 确认红灯。
- [x] 加配置测试：产品名/二进制名 EnvDock、bundle active、NSIS currentUser、旧 identifier、无资源/sidecar；以 `node --test scripts/test-packaging.mjs` 验证红灯。
- [x] 修改显示名称；启用 NSIS 中文/英文、当前用户安装；只构建本地源代码。`mainBinaryName = EnvDock`，不改 crate 名称。
- [x] 新增构建脚本：加载 `env.ps1`，调用本地 Tauri CLI `build --bundles nsis -- --locked`；检查退出码、仅取当前版本 x64 安装器；输出指定安装包名和 SHA256。不复制数据目录。
- [x] 便携版继续显式启用 `portable,custom-protocol`，独立输出 `EnvDock.exe` 和说明/校验和。
- [x] 重跑测试；检查真实生成的 NSIS 脚本，确认开始菜单、桌面快捷方式选项、升级与卸载行为。

## Task 2 — 显式数据迁移

Files: `scripts/migrate-local-data.ps1`, `scripts/test-migrate-local-data.ps1`.

- [x] 先以临时合成文件测试：成功复制、拒绝已存在目标数据库、拒绝同目录/嵌套目录、拒绝锁定文件和重解析点。
- [x] 实现迁移：显式源路径、默认目标 `%LOCALAPPDATA%\ApiWorkbench`；检查进程、独占源文件，先备份后复制，包含 DB/WAL，校验哈希，不删除原件；失败不能留下可误用的半成品 app.db。
- [x] 脚本不依赖 Python，不操作真实用户目录进行测试；记录迁移备份位置。DPAPI 只支持同 Windows 用户迁移。
- [x] 执行 PowerShell 测试并审核失败路径和数据保护。

## Task 3 — 验证与交付

Files: `README.md`, `docs/test.md`.

- [x] 更新安装、迁移、卸载保留数据、WebView2、未签名与 SHA256 检查说明。
- [x] 运行前端全套、Rust 全套、fmt/clippy、前端 build；实际生成 NSIS 和便携版。
- [x] 校验产物 PE/架构/版本/哈希/包内容，确保不存在业务 DB、Yaak 文件、配置凭据。
- [x] 如未做真实安装/卸载，明确标记未验证，不能把静态脚本检查写成安装成功。
- [x] 追加测试记录与阶段总结，不覆盖旧记录。不自动提交、推送、发布 Release 或替换正在运行的旧程序。

## 风险与回滚

- 无新数据库迁移，现有 schema v3 保持不变。
- 未购买代码签名证书，可能被 Windows 提示未知发布者；不绕过系统安全策略。
- 缺 WebView2 的机器安装引导可能需要联网；应用数据仍仅在本机。
- 原便携目录原样保留。需要回退时先退出新旧程序，使用原程序和原数据，不覆盖较新数据。

## 完成状态（2026-10-03）

- 已交付本地 NSIS 安装器、便携预览、说明、迁移脚本与 SHA256；详见 docs/test.md 的 ENVD-SETUP-1003。
- 打包额外修复：前后端 Tauri 小版本对齐；NSIS 双入口降级拦截（实测默认 allowDowngrades 配置不足）。
- 517 项基础自动化通过，另有安装/重装/卸载/静默降级及真实合成 SQLite WAL 验证。
- 未执行交互安装完整向导、真实私有数据迁移、无 WebView2 环境验证；原程序/快捷方式未替换。
- 无新 schema、无 Git 提交/推送/Release。
