# EnvDock macOS 适配

当前功能基线为 共享 main / macOS **v2.0.2**。两端业务功能由同一套 React、TypeScript 和 Rust/Tauri 共享源码提供；跨版本功能逐项对照见 [macOS / Windows 功能对照](macOS-feature-matrix.md)。

## 源码分析

- 前端：React 19、TypeScript、Vite，CodeMirror JSON 编辑器。
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

测试初始化已兼容 Node 25 的实验性 Web Storage；默认使用两个 worker，避免低资源机器并发过高。Rust 单元测试使用内存密钥，不访问真实登录钥匙串。
钥匙串集成测试单独执行：`cargo test --manifest-path src-tauri/Cargo.toml login_keychain_roundtrip -- --ignored`，系统可能请求钥匙串访问。

本地构建没有 Apple Developer ID 签名和公证。分发给其他 Mac 前应使用自己的开发者证书签名并公证，不要全局关闭 Gatekeeper。


## 平台范围

macOS 保留 Windows 版本的项目、环境、接口、请求、响应、导入导出、临时请求、JSON 工具、开发工具、OpenAPI、请求时间线、诊断、命令面板、快捷键、窗口控件、主题和直接 Bearer Token 功能。Windows-only 的 NSIS/WebView2/PowerShell/portable/DPAPI/卸载清理属于平台交付实现，Mac 使用 `.app/.dmg`、WebKit、Application Support、登录钥匙串和 AES-256-GCM 提供对应平台实现。

数据库 schema、IPC 命令、请求执行协议、响应缓存、Bundle ID `local.apiworkbench.desktop` 和钥匙串服务保持兼容，没有新增 Mac 专用业务入口。

## 本次交付

macOS 2.0.2 使用 B「双舱桥」图标和共享 main 功能基线，SQLite schema、Bundle ID、数据目录与钥匙串服务保持兼容。

构建输出为 `src-tauri/target/release/bundle/`（Intel）与 `src-tauri/target/aarch64-apple-darwin/release/bundle/`（arm64）。整理后的当前交付存于本机 `交付产品/EnvDock-macOS-2.0.2/`，包含 DMG、校验文件、许可证、构建与验证信息。

Intel 版本必须完成安装启动验证；arm64 需在 Apple Silicon 设备上完成最终启动验收。具体结果以交付目录的 `VERIFICATION.json` 为准。
