# EnvDock macOS / Windows 功能对照

本表以仓库 `v1.8.1`（`f93d868`）为基线，逐个核对 Windows 发布说明、共享 React/Rust 实现和 macOS 构建配置。业务功能由同一套前端与 Tauri 命令承载；平台差异只保留在安装、数据目录、密钥设施和系统窗口接口。

## 跨版本功能清单

| 版本 | Windows 功能点 | macOS 对应实现 | 证据 |
| --- | --- | --- | --- |
| 1.0 | 项目、服务、目录、接口、环境隔离、地址矩阵、自动保存、Query/Header/Body/Auth/变量/表单/文件、响应查看与缓存、生产确认、导入导出、cURL | 同等实现 | `src/App.tsx`, `src/hooks/useWorkbench.ts`, `src/components/RequestEditor.tsx`, `src/components/ResponsePanel.tsx`, `src/lib/transfer.ts` |
| 1.1 | 请求 JSON 格式化、去 null、搜索、折叠、复制；临时 JSON 工具窗口 | 同等实现 | `src/lib/json-format.ts`, `src/components/JsonToolsDialog.tsx`, `docs/releases/1.1.0-json-tools.md` |
| 1.2 | JSON 双栏精确对比、转义还原、字段提取、CSV/SQL IN、请求时间线、响应比较、诊断与脱敏排查包 | 同等实现 | `src/components/JsonCompareTool.tsx`, `src/components/JsonStringTool.tsx`, `src/components/JsonExtractPanel.tsx`, `src/components/RequestHistoryDialog.tsx`, `src/lib/investigation-report.ts`, `src-tauri/src/report_files.rs` |
| 1.3 | 开发工具箱、OpenAPI/Swagger 离线导入更新、响应布局、主题、1px 分隔线、诊断脱敏 | 同等实现 | `src/components/DevToolsDialog.tsx`, `src/lib/openapi.ts`, `src/components/SettingsPanel.tsx`, `src/styles.css` |
| 1.4 | 无项目临时请求：完整 HTTP/HTTPS URL、多标签、Params/Headers/Auth/Body、取消、超时、响应诊断 | 同等实现 | `src/components/TemporaryRequests.tsx`, `src/hooks/useTemporaryRequests.ts`, `src-tauri/src/engine/temporary.rs` |
| 1.5 | `/` 与 Ctrl/Cmd+K 搜索、常驻脱敏 URL/cURL/超时、标签全部切换和右键关闭、批量关闭一次保存 | 同等实现 | `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/RequestTabs.tsx`, `src/components/ResponsePanel.tsx` |
| 1.6 | 最近关闭标签恢复、命令面板、快捷键总览、Ctrl/Cmd+W、分隔条双击复位、响应搜索上下文 | 同等实现 | `src/lib/closed-tabs.ts`, `src/lib/commands.ts`, `src/components/CommandPalette.tsx`, `src/components/ShortcutsDialog.tsx`, `src/components/ResizeHandle.tsx` |
| 1.7 | JSON 行/块注释、发送/预览/cURL 前剥离注释、Ctrl/Cmd+/ 批量注释、编辑器语法色、自绘窗口控件 | 同等实现 | `src/lib/json-comments.ts`, `src/lib/json-format.ts`, `src-tauri/src/engine/body.rs`, `src/components/WindowControls.tsx`, `src-tauri/capabilities/default.json` |
| 1.7.1 | 无标题栏窗口权限修复、窗口拖动/最小化/最大化/关闭、WebView 缓存恢复目录 | 同等实现 | `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |
| 1.8 | 浅色、深色、系统、石墨黑四主题；请求/响应底色和语法色；旧主题回退 | 同等实现 | `src/components/SettingsPanel.tsx`, `src/lib/preferences.ts`, `src/themes.css`, `docs/releases/v1.8.0.md` |
| 1.8.1 | 直接 Bearer Token、完整变量引用、非法混合花括号/控制字符拒绝 | 同等实现 | `src/components/AuthEditor.tsx`, `src-tauri/src/engine/auth.rs`, `src-tauri/src/store.rs`, `src-tauri/src/engine/tests/v02.rs` |

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

## 当前核对结论

- 共享业务入口、请求执行命令、SQLite schema、变量/鉴权、导入导出、临时请求和全部工作台工具在两平台共用。
- 没有发现仅 Windows 才能使用的业务入口，也没有发现 Mac 额外暴露的业务功能。
- Mac 仍有与 Windows 一致的产品限制：HTTP/1、无系统代理/自动重试/自动重定向、非 UTF-8 有损展示、无 OAuth/WebSocket/gRPC/脚本/批量测试。
- 当前验证基线：前端 76 个测试文件、1100 项通过；13 项打包检查通过；直接 Bearer Token 原生回归通过；Intel 与 arm64 Release 均完成构建，arm64 需 M 系列实机再验收。
- 后续每次 Windows 版本升级，应先在本表新增版本行，再核对共享源码、Mac 构建和对应 UI/原生回归，避免只更新版本号而漏同步功能。
