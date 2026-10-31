# EnvDock macOS 适配

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
NODE_OPTIONS=--no-experimental-webstorage npm test -- --maxWorkers=2
npm run build
npm run test:packaging
sh scripts/mac.sh test
```

Node 25 默认的实验性 Web Storage 与原有 jsdom 测试冲突，测试时需关闭该特性。
钥匙串集成测试单独执行：`cargo test --manifest-path src-tauri/Cargo.toml login_keychain_roundtrip -- --ignored`，系统可能请求钥匙串访问。

本地构建没有 Apple Developer ID 签名和公证。分发给其他 Mac 前应使用自己的开发者证书签名并公证，不要全局关闭 Gatekeeper。


## 本次验证（2026-10-31）

- 源码基线：`270f0be`，本机 Intel x86_64 / macOS 13.7.8。
- 前端：42 个文件、621 项测试通过；TypeScript / Vite 生产构建通过。
- 既有打包检查：11 项通过。
- Rust：120 项单元测试、2 项集成测试通过；另行执行 1 项默认跳过的登录钥匙串测试并通过。
- 加密验证包括 Unicode / 空字符串往返、随机 nonce、错误密钥及篡改拒绝，以及加密响应写入、重开读取和数据隔离。
- Release `.app` / `.dmg` 均生成成功，DMG 经 `hdiutil verify` 校验通过。
- 已启动应用，确认进程持续运行，并在正确的 Application Support 目录创建数据库。
- 桌面控制服务启动失败，未完成界面截图及逐项点击验证；没有把进程启动检查当作完整 UI 验收。
- 应用未使用 Apple Developer ID 签名或公证；未验证 Apple Silicon 原生构建。

交付目录：`publish/EnvDock-1.0.0-macos-x64/`。打开 DMG 后将 EnvDock 拖到 Applications，或直接双击目录中的 `.app`。
