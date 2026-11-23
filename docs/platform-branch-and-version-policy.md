# EnvDock GitHub 分支与版本规定

本文是 `api-workbench` 仓库的长期维护规则。目标是让 GitHub 中的源码、平台分支、版本标签和历史版本各自有明确位置。

## 1. GitHub 长期结构

仓库只保留三条长期分支：

```text
main
├── 共享 React / TypeScript / Rust / SQLite / IPC / 请求引擎
├── 跨平台数据模型与业务规则
└── 项目说明、功能矩阵、版本与发布规定

windows
├── 从 main 同步的完整源码
├── Windows Tauri 配置、NSIS 安装器和 PowerShell 脚本
├── Windows DPAPI、WebView2 和窗口适配
└── Windows 安装包与便携版发布记录

macos
├── 从 main 同步的完整源码
├── macOS Tauri 配置、应用包和 DMG 配置
├── macOS Keychain、WebKit 和窗口适配
└── Intel / Apple Silicon 发布记录
```

`main` 不是只放说明的空分支。共享业务代码必须在 `main` 保持唯一来源，避免 Windows 和 macOS 各自复制一份请求编辑器、请求引擎或 SQLite 逻辑后逐渐漂移。平台分支保留完整工程，用于平台适配、平台构建和最终发布。

平台差异只能进入平台配置、系统 API 适配、安装器、签名和交付脚本。接口编辑、变量、鉴权、请求执行、响应处理、导入导出和数据结构等共享能力，先在 `main` 完成，再同步到 `windows` 和 `macos`。

## 2. 分支操作规定

### 2.1 日常开发

1. 共享功能从 `main` 开始开发。
2. Windows 专属修改进入 `windows`。
3. macOS 专属修改进入 `macos`。
4. 平台分支发布前必须同步当前 `main`，并核对 `docs/macOS-feature-matrix.md`。
5. 临时分支可使用 `codex/*`、`feature/*` 或 `fix/*`，完成合并或交付后删除，不作为长期入口。

### 2.2 提交边界

- `main`：共享源码、跨平台契约、测试、文档和功能基线。
- `windows`：Windows 构建、安装、卸载、WebView2、DPAPI 和 Windows 交付说明。
- `macos`：macOS 构建、`.app` / `.dmg`、Keychain、签名和 macOS 交付说明。
- 交付包、数据库、真实接口数据、凭据和本机安装备份不提交到源码仓库。

### 2.3 GitHub 页面清理

- GitHub 默认分支保持 `main`。
- 长期分支只展示 `main`、`windows`、`macos`。
- `codex/macos-2.0.0` 这类一次性工作分支完成整理后删除。
- 旧版本不通过重复长期分支保存；源码通过 Git 提交历史追溯，不再长期保留重复 tag 和 Release。

## 3. 版本号与标签规定

### 3.1 版本号

版本号采用 `主版本.次版本.修订版本`：

```text
X.Y.Z
```

- 主版本：不兼容的产品或数据契约变化。
- 次版本：新增兼容功能。
- 修订版本：兼容的修复、性能和界面调整。
- 同一功能基线的 Windows 与 macOS 可以有不同修订号，平台是否一致以功能矩阵和共享提交为准。

当前平台版本规定沿用已发布方案：

- macOS 使用偶数修订号，例如 `2.0.0`。
- Windows 使用奇数修订号，例如 `2.0.1`。
- 例如同一条 2.0 功能线，macOS 为 `2.0.0` 时，Windows 对应为 `2.0.1`。
- 历史版本不改名、不重写；当前清理后每个平台只保留最新版本标签，后续发布必须带平台后缀。

### 3.2 Git tag

新版本 tag 必须带平台后缀：

```text
v<X.Y.Z>-windows
v<X.Y.Z>-macos
```

当前已整理的版本：

| 平台 | 分支 | 版本 | Git tag |
| --- | --- | --- | --- |
| Windows | `windows` | `2.0.1` | `v2.0.1-windows` |
| macOS | `macos` | `2.0.0` | `v2.0.0-macos` |

不带平台后缀的旧版本号不再用于新发布。tag 必须指向完成版本校验的提交，不指向临时开发分支。

### 3.3 GitHub Release

每个最终版本在发布时建立对应平台的 GitHub Release：

- Windows Release 使用 `v<X.Y.Z>-windows`。
- macOS Release 使用 `v<X.Y.Z>-macos`。
- Release 标题包含平台和版本，例如 `EnvDock Windows 2.0.1`。
- Release 正文必须写明源码提交、构建环境、验证范围、已知限制和 SHA-256 校验文件。
- Windows Release 上传 Windows 安装器、完整 ZIP、许可证和校验文件。
- macOS Release 上传 Intel 与 Apple Silicon 的 DMG、许可证、构建记录和校验文件。
- 同一平台发布新版后，用新版 Release 替换旧 Release；GitHub 页面只保留每个平台的最新下载入口。

## 4. 版本归档与精简

仓库和本地目录保持单一最新交付，不建立重复归档层：

```text
GitHub
├── Branches: main / windows / macos
├── Releases: Windows / macOS 各一个最新版本
└── Tags: Windows / macOS 各一个当前版本标签

本地交付目录
└── 交付产品
    └── 当前平台版本
```

旧版本源码通过 Git 提交历史追溯。替换当前 Release 前，必须确认新版已提供安装包、校验文件、许可证和迁移说明；不在本地保留 `archive`，也不为每个历史版本重复创建长期 Release。

## 5. 发布前检查

发布任何平台版本前，必须完成：

1. 分支名称、版本号、tag 后缀和 Release 标题一致。
2. `main` 的共享功能已经同步到目标平台分支。
3. 平台功能矩阵没有遗漏，平台差异只位于系统适配与交付层。
4. 版本检查、前端测试、Rust 测试、打包检查和安装启动验证完成。
5. 安装包、ZIP/DMG、许可证和 SHA-256 校验文件齐全。
6. Release 正文记录未完成的架构、签名或实机验证项目。

## 6. 当前整理结果

截至 2026-11-23：

- `main`：共享源码与仓库说明，当前 Windows 业务基线为 `2.0.1`，已补齐 macOS `2.0.0` 的共享能力。
- `windows`：Windows 长期发布分支，基于 `main` 建立。
- `macos`：macOS 长期发布分支，由现有 `macos-2.0.0` 整理而来。
- `v2.0.1-windows`：Windows 当前唯一 Release 和标签。
- `v2.0.0-macos`：macOS 当前唯一 Release 和标签。
- 旧版本：从 Git 提交历史追溯，不再保留重复 Release、标签或本地归档目录。
- `codex/macos-2.0.0`：整理完成后删除，不作为用户入口。
