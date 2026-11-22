# EnvDock macOS 适配

当前源码版本为 **v2.0.0**。本次只交付 macOS，沿用同一套 React、TypeScript 和 Rust/Tauri 业务实现；已验证功能仍以 v1.8.1 为基线，跨版本功能逐项对照见 [macOS / Windows 功能对照](macOS-feature-matrix.md)。

2.0.0 Intel x64 和 arm64 DMG 已生成并完成磁盘镜像校验；Intel 版本已在本机启动验证。现有 `EnvDock-macOS-1.8.1` 交付目录仍是历史产物，不能与 2.0.0 混用。

2.0.0 同步加入渲染异常恢复界面、稳定快捷键监听、工作台派生数据记忆化、浅色主题对比度修正、CSP 基础加固，以及不依赖真实登录钥匙串的 Rust 单元测试路径。

## 源码分析

- 前端：React 19、TypeScript、Vite、Zustand，CodeMirror JSON 编辑器。
- 原生：Tauri 2 / Rust，reqwest 执行 HTTP，请求取消与流读取由 Tokio 处理。
- 数据：SQLite（bundled SQLite），项目、服务、环境、变量、请求和响应缓存均保存在本地。
- 上游 Windows 限制：PowerShell 启动脚本、NSIS 安装器、LOCALAPPDATA 数据目录、DPAPI 敏感值加密。

## Mac 适配

- 使用 Tauri 自动合并的 `tauri.macos.conf.json`，生成 `.app` 和 `.dmg`，保留 Windows 配置。
- 数据保存至 `~/Library/Application Support/local.apiworkbench.desktop/`，应用包与用户数据分开。
- 敏感值使用 AES-256-GCM，随机 256 位密钥保存在登录钥匙串，数据库只保存版本标识、随机 nonce 和密文。每次加密生成独立 nonce，认证失败不返回明文。钥匙串不可用则拒绝操作。
- Windows DPAPI 密文无法直接在 Mac 解密，迁移时需重新输入敏感值。备份数据库不能替代钥匙串密钥备份。
- 使用现有品牌图案生成 ICNS 图标；新增启动、构建脚本，支持项目内隔离 Rust。
- 应用包使用完整 ad-hoc 临时签名封装资源；这不等同于 Apple Developer ID 签名或公证。

## 开发和构建

需要 Node.js 22 LTS（或更新兼容版本）、Rust stable、Xcode Command Line Tools。

```sh
npm ci
npm run desktop:mac
npm run build:mac
```

输出位于 `src-tauri/target/release/bundle/macos/EnvDock.app` 和 `src-tauri/target/release/bundle/dmg/`。
Apple Silicon（M 系列）交叉构建：

```sh
rustup target add aarch64-apple-darwin
npm run build:mac:arm64
```

M 系列输出位于 `src-tauri/target/aarch64-apple-darwin/release/bundle/`。交叉编译不能代替 M 系列设备的实际启动验证。

```sh
npm run test:ci
npm run build
npm run test:packaging
sh scripts/mac.sh test
```

项目使用 Node.js 22 LTS 作为可复现基线（见 `.nvmrc`）。测试初始化会把 Node 25 的实验性 Web Storage 转接到 jsdom 的内存实现；低资源机器和 CI 使用 `npm run test:ci`，将 Vitest 并发 worker 限制为 2，并给负载较高的用例 15 秒超时预算。
钥匙串集成测试单独执行：`cargo test --manifest-path src-tauri/Cargo.toml login_keychain_roundtrip -- --ignored`，系统可能请求钥匙串访问。

本地构建没有 Apple Developer ID 签名和公证。分发给其他 Mac 前应使用自己的开发者证书签名并公证，不要全局关闭 Gatekeeper。


## 平台范围

macOS 保留 Windows 版本的项目、环境、接口、请求、响应、导入导出、临时请求、JSON 工具、开发工具、OpenAPI、请求时间线、诊断、命令面板、快捷键、窗口控件、主题和直接 Bearer Token 功能。Windows-only 的 NSIS/WebView2/PowerShell/portable/DPAPI/卸载清理属于平台交付实现，Mac 使用 `.app/.dmg`、WebKit、Application Support、登录钥匙串和 AES-256-GCM 提供对应平台实现。

数据库 schema、IPC 命令、请求执行协议、响应缓存、Bundle ID `local.apiworkbench.desktop` 和钥匙串服务保持兼容，没有新增 Mac 专用业务入口。

## 1.8.1 验证记录（2026-11-17）

- 源码基线：`f93d868`（v1.8.1）；Windows v1.0-v1.8.1 已按对照矩阵核查。
- 本机：Intel x86_64 / macOS 13.7.8；Node 25.6、Rust 1.99.1、Xcode SDK 13.3。
- 前端：76 个源码测试文件、1100 项通过；临时请求测试单独重跑 8/8 通过；TypeScript / Vite 生产构建通过。
- 打包规则：13 项通过；直接 Bearer Token 原生回归通过。
- Intel 和 Apple Silicon（arm64）v1.8.1 Release `.app` / `.dmg` 均生成成功，DMG 经 `hdiutil verify` 校验，应用经 `codesign --deep --strict` 和架构检查。
- 已启动 Intel 应用，确认旧工作区、项目、环境和接口正常载入；石墨黑主题即时切换及重启保存通过，随后恢复原深色偏好。
- 升级前使用 SQLite backup API 保存 app.db（含 WAL 工作区）；升级前后 integrity check 为 `ok` 且逻辑内容一致。
- M 系列版本由 Intel Mac 交叉编译，未进行 M 系列设备实际启动验证。
- 应用使用临时 ad-hoc 签名，未使用 Apple Developer ID 签名或公证。

当前 2.0.0 构建输出位于 `src-tauri/target/release/bundle/`（Intel）和 `src-tauri/target/aarch64-apple-darwin/release/bundle/`（arm64），包含 `.app` 与 `.dmg`。交付目录仍被 `.gitignore` 忽略；打开对应架构的 DMG，将 EnvDock 拖到 Applications。
