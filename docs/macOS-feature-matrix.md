# EnvDock macOS / Windows 功能对照

本表记录共同的业务能力与两个操作系统各自的验收边界。`main` 是功能主线，`windows` 与 `macos` 实现系统适配；**功能和图标必须一致，系统实现方式不要求相同**。既有发布基线是 Windows `v2.0.1` 与 macOS `v2.0.0`；源码更新后必须重新核对，不能仅凭沿用版本说明宣称验证完成。

## 共同业务能力

| 功能来源版本 | 共同能力 | 实现要求 | 共享代码与测试入口 |
| --- | --- | --- | --- |
| 1.0 | 项目、服务、目录、接口、环境隔离、地址矩阵、自动保存、Query/Header/Body/Auth/变量/表单/文件、响应查看与缓存、生产确认、导入导出、cURL | 两端必须提供；共享测试与平台验收共同确认 | `src/App.tsx`, `src/hooks/useWorkbench.ts`, `src/components/RequestEditor.tsx`, `src/components/ResponsePanel.tsx`, `src/lib/transfer.ts` |
| 1.1 | 请求 JSON 格式化、去 null、搜索、折叠、复制；临时 JSON 工具窗口 | 两端必须提供；共享测试与平台验收共同确认 | `src/lib/json-format.ts`, `src/components/JsonToolsDialog.tsx` |
| 1.2 | JSON 双栏精确对比、转义还原、字段提取、CSV/SQL IN、请求时间线、响应比较、诊断与脱敏排查包 | 两端必须提供；共享测试与平台验收共同确认 | `src/components/JsonCompareTool.tsx`, `src/components/JsonStringTool.tsx`, `src/components/JsonExtractPanel.tsx`, `src/components/RequestHistoryDialog.tsx`, `src/lib/investigation-report.ts`, `src-tauri/src/report_files.rs` |
| 1.3 | 开发工具箱、OpenAPI/Swagger 离线导入更新、响应布局、主题、1px 分隔线、诊断脱敏 | 两端必须提供；共享测试与平台验收共同确认 | `src/components/DevToolsDialog.tsx`, `src/lib/openapi.ts`, `src/components/SettingsPanel.tsx`, `src/styles.css` |
| 1.4 | 无项目临时请求：完整 HTTP/HTTPS URL、多标签、Params/Headers/Auth/Body、取消、超时、响应诊断 | 两端必须提供；共享测试与平台验收共同确认 | `src/components/TemporaryRequests.tsx`, `src/hooks/useTemporaryRequests.ts`, `src-tauri/src/engine/temporary.rs` |
| 1.5 | `/` 与 Ctrl/Cmd+K 搜索、常驻脱敏 URL/cURL/超时、标签全部切换和右键关闭、批量关闭一次保存 | 两端必须提供；共享测试与平台验收共同确认 | `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/RequestTabs.tsx`, `src/components/ResponsePanel.tsx` |
| 1.6 | 最近关闭标签恢复、命令面板、快捷键总览、Ctrl/Cmd+W、分隔条双击复位、响应搜索上下文 | 两端必须提供；共享测试与平台验收共同确认 | `src/lib/closed-tabs.ts`, `src/lib/commands.ts`, `src/components/CommandPalette.tsx`, `src/components/ShortcutsDialog.tsx`, `src/components/ResizeHandle.tsx` |
| 1.7 | JSON 行/块注释、发送/预览/cURL 前剥离注释、Ctrl/Cmd+/ 批量注释、编辑器语法色、自绘窗口控件 | 两端必须提供；共享测试与平台验收共同确认 | `src/lib/json-comments.ts`, `src/lib/json-format.ts`, `src-tauri/src/engine/body.rs`, `src/components/WindowControls.tsx`, `src-tauri/capabilities/default.json` |
| 1.7.1 | 无标题栏窗口权限修复、窗口拖动/最小化/最大化/关闭、WebView 缓存恢复目录 | 两端必须提供；共享测试与平台验收共同确认 | `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |
| 1.8 | 浅色、深色、系统、石墨黑四主题；请求/响应底色和语法色；旧主题回退 | 两端必须提供；共享测试与平台验收共同确认 | `src/components/SettingsPanel.tsx`, `src/lib/preferences.ts`, `src/themes.css` |
| 1.8.1 | 直接 Bearer Token、完整变量引用、非法混合花括号/控制字符拒绝 | 两端必须提供；共享测试与平台验收共同确认 | `src/components/AuthEditor.tsx`, `src-tauri/src/engine/auth.rs`, `src-tauri/src/store.rs`, `src-tauri/src/engine/tests/v02.rs` |
| 2.0.1 / 2.0.0 | 快捷键监听稳定化、工作台派生数据记忆化、渲染异常恢复、测试环境兼容、主题弱化文字、启动错误诊断、CSP 加固和版本校验 | 共享行为一致；构建、数据目录和系统适配分别验收 | `src/App.tsx`, `src/hooks/useWorkbench.ts`, `src/components/ErrorBoundary.tsx`, `src/test/setup.ts`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `scripts/check-version.mjs` |
| macOS 2.0.2 / Windows 2.0.3 源码候选 | B「双舱桥」统一图标；共享主线同步；平台路径检查、测试密钥和窗口/构建实现分别保留 | 源码与品牌资源需通过跨分支校验；Windows 新安装包仍待目标系统构建与验收 | `assets/brand/mark.svg`, `assets/brand/exports.json`, `scripts/check-platform-parity.mjs`, `src-tauri/src/platform_paths.rs` |

## 统一品牌图标

当前选择 B「双舱桥」，母版为 `assets/brand/mark.svg`。应用内 SVG、Tauri PNG / ICNS / ICO 与安装器品牌位图由同一母版生成，三个分支的同路径资源应具有相同 SHA-256。导出清单在 `assets/brand/exports.json`；平台包装、安装方式或系统缓存刷新可以不同。

图标核对既检查母版，也检查实际打包的格式，不能只把网页 SVG 换成新图标。发布验收还应确认桌面、Dock/开始菜单、窗口和应用内品牌入口显示同一标记。

## 平台差异

以下内容是操作系统交付实现，不属于 Mac 缺少的业务功能：

| Windows 实现 | macOS 等价实现 | 说明 |
| --- | --- | --- |
| NSIS 安装器、卸载清理、迁移脚本、WebView2 自动准备、快捷方式 | `.app` / `.dmg`、Applications 拖放安装 | 安装器不能跨平台复用；应用内工作区功能相同 |
| `%LOCALAPPDATA%\ApiWorkbench` | `~/Library/Application Support/local.apiworkbench.desktop/` | 数据目录不同，SQLite schema、IPC 和工作区模型相同 |
| Windows DPAPI | 登录钥匙串中的 AES-256-GCM 密钥 | 密钥设施不同；Windows 密文不能直接在 Mac 解密，需要重新输入秘密值 |
| portable EXE / `ApiWorkbenchData` | 不提供 portable EXE | Windows 交付形态，不是业务功能 |
| Authenticode | ad-hoc 签名（发布时可替换为 Developer ID） | 签名体系不同，均不改变应用功能 |
| Windows WebView2 缓存恢复 | macOS WebKit 数据目录与同一恢复逻辑 | 依赖运行时不同，窗口和请求功能相同 |

文件上传、报告导出和路径安全在 Windows 与 macOS 使用各自系统 API 检查符号链接/重解析点，行为目标一致；不能把平台 API 不同误判成能力缺失。

## 核对与验收

```sh
node scripts/check-platform-parity.mjs --base main --targets windows,macos
node --test scripts/check-platform-parity.test.mjs
npm run check:version
npm run test:ci
npm run test:packaging
npm run build
```

跨分支工具逐文件比较共享源码、测试和迁移内容，核对 IPC 注册命令，并输出品牌资源 SHA-256。系统适配的实现差异单独报告。文件相同不代表系统行为已经验收；文件存在更不能作为功能一致的证据。

| 验收层 | 核对内容 | 完成条件 |
| --- | --- | --- |
| 共享源码 | 工作台入口、变量/鉴权、请求规则、响应、JSON、导入导出、模型/迁移、自动测试 | 三分支内容一致，跨分支检查和共享测试通过 |
| 品牌资源 | B 母版、应用 SVG、PNG / ICO / ICNS、安装器品牌位图 | 生成清单一致，同路径 SHA-256 一致 |
| Windows 原生 | WebView2、DPAPI、窗口、文件、安装/卸载、实际 EXE 中的图标 | 在 Windows 构建机生成并完成安装与启动验收 |
| macOS 原生 | WebKit、Keychain、窗口、文件、`.app/.dmg`、Dock 图标 | 在 Mac 构建并完成安装、启动、签名和图标检查 |
| Apple Silicon | arm64 架构、包签名和实际启动 | 交叉编译可检查构建与架构；启动仍需 M 系列设备 |

当前任务可同步 Windows 的源码和图标，不能在 Mac 上宣称 Windows EXE 已重新构建或实测。原 Windows 已发布包保持原验证状态，等待 Windows 构建机完成新版交付。共享功能以 `main` 为准；平台适配不得因同步丢失已有系统修复。

两端共同的产品限制继续适用：HTTP/1、无系统代理/自动重试/自动重定向、非 UTF-8 有损展示、无 OAuth/WebSocket/gRPC/脚本/批量测试。后续新增功能先更新共享代码与本表，再同步平台分支。

分工、版本奇偶和发布规则见 [GitHub 分支与版本规定](platform-branch-and-version-policy.md)。
