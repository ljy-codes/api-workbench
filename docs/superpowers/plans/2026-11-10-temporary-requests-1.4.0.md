# Temporary Requests 1.4.0 Implementation Plan

> **For agentic workers:** Use focused parallel implementation for the native execution path and inline implementation for the frontend. Follow the task boundaries below.

**Goal:** 交付无需环境即可使用的临时接口及 1.4.0 安装包，重点是直接调试，不为无痕增加复杂机制。

**Architecture:** 临时请求使用独立内存 Hook 和专用 native IPC，复用编辑控件和原生 transport；不进入 useWorkbench 的保存、历史、缓存链路。普通请求归属检查保持不变。

**Tech Stack:** React 19 / TypeScript / Tauri 2 / Rust / reqwest / Vitest。

**Spec:** `docs/superpowers/specs/2026-11-10-temporary-requests-1.4.0-design.md`

## Global Constraints

- 临时标签自然保留在独立内存模型中，不接入普通工作区保存链路；不增加额外的数据擦除或无痕机制。
- 不继承工作区 Token、服务 Headers 或变量。
- 版本统一为 1.4.0，不操作本机安装、推送或 Release。
- 保留现有用户未跟踪文件；不做无关重构。

### Task 1: Native temporary execution

**Files:** `src-tauri/src/models.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/engine.rs`, 新增临时准备模块与测试；必要时小范围共享准备代码。

**Interfaces:** `TemporaryExecuteInput { executionId, request: TemporaryRequest }`；`TemporaryRequest { url, method, query, headers, bodyType, body, timeoutMs, auth?, form? }`。命令 `preview_temporary_request` 返回 `Preview`；`send_temporary_request` 返回 `DetailedExecutionResult`；复用 `cancel_request`。

- [x] 先写完整 URL、重复 Query、鉴权、multipart、取消/超时、非法 URL 测试并观察失败。
- [x] 实现无 Store 路径；直接凭据仅临时有效，展示 URL 脱敏；保持普通 context 校验。
- [x] 本地回环 HTTP 测试验证实际方法、URL、Body、Headers 与取消/超时；运行 Rust 回归。

### Task 2: Memory sessions and shared editor

**Files:** 新增 `src/hooks/useTemporaryRequests.ts` 及测试；`src/hooks/useResponseBaselines.ts`、`src/types.ts`、`src/lib/ipc.ts`、`src/components/RequestEditor.tsx`、`src/components/AuthEditor.tsx`。

**Interfaces:** Hook 提供 tabs、selectedId、request、execution、preview、notice、hasRunning、open/select/close/closeAll/updateRequest/execute/cancel/clearResponse。通过专用 API 使用 Task 1 契约。

- [x] Hook 测试验证独立标签、关闭清空、迟到响应不复活、取消、专用 IPC 与无持久化。
- [x] 测试失败后实现内存状态；异步结果按执行 ID 和标签 ID 归属；卸载取消全部。
- [x] 将编辑器共享内容小范围抽取，普通入口保留，临时入口不受环境禁用；Auth 临时模式允许直接填写凭据。
- [x] 回归普通请求编辑、格式化、复制、环境隔离。

### Task 3: Application integration

**Files:** 新增 `src/components/TemporaryRequests.tsx`、`src/App.temporary.test.tsx`；修改 `src/App.tsx`、`src/components/ResponsePanel.tsx`、`src/styles.css`。

- [x] 先写空工作区入口、快捷键、关闭重开空白、无历史/缓存写入、运行时退出保护测试。
- [x] 接入「临时请求」导航与标签栏，状态显示「无环境 · 仅内存」，提供新建和关闭全部。
- [x] 临时页共享布局偏好与响应面板，基准按标签在内存保留；Ctrl+S 不调用普通保存，Ctrl+Enter 正确路由。
- [x] 执行定向测试，视觉检查与键盘操作检查。

### Task 4: Version, verification and delivery

**Files:** `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`README.md`、`docs/releases/v1.4.0.md`、本地 `docs/test.md`。

- [x] 同步升级所有版本文件为 1.4.0，编写临时功能操作方式、数据边界和兼容说明。
- [x] `npm test -- --maxWorkers=2 --reporter=dot`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`、`npm run build`、`npm run test:packaging`。
- [x] 对临时标签归属、URL/鉴权处理和普通链路兼容性做独立代码审查，修复必要问题。
- [x] `scripts/build-installer.ps1`，复制发布说明、生成 ZIP 与 SHA256；确认实际产物版本并记录结果。

## Progress

- 已确认调用链：普通 execute 会自动保存、缓存与记录时间线，临时请求必须独立执行。
- 已确认普通 context 严格检查项目/服务/环境，不放松这些检查。
- 已确认现有未跟踪文件均属原有内容，保留。
- 用户最新澄清：记录与否不是重点，无需为了无痕增加复杂处理；核心是无环境时仍可用。独立内存标签作为最小自然实现继续。
- 已完成前端内存 Hook、共享编辑器、直接填写临时鉴权、临时页面入口及快捷键；定向 12 项通过，原编辑器相关 32 项通过。
- 原生执行完成：172 单元 + 2 集成测试通过。前端初次全量 67 文件、1076 项通过；补上已有项目但无环境入口测试后定向通过。
- 独立审查发现异步文件选择可覆盖其他标签、响应比较基准随面板卸载丢失；先以 3 项失败测试复现，再绑定编辑回调目标标签并提升基准生命周期。修复后 18 项定向回归通过。
- 正式前端产物在 1280×800 页面检查了空工作区入口、临时标签、完整地址及草稿切换；浏览器仅做界面检查，真实发送由 Rust 回环测试覆盖。
- 最终前端 67 文件、1080 项通过；Rust 172 单元 + 2 集成通过；打包规则 11 项通过。打包前 TypeScript 检查发现测试中两个多余 `exact` 参数，移除后 8 项 App 集成测试及生产前端构建通过，产品代码未改变。
- 安装交付完成：`scripts/build-installer.ps1` 退出码 0，原生程序和安装器实际版本均为 1.4.0；生成 `publish/EnvDock-1.4.0-windows-x64`、同名 ZIP 与 `publish/SHA256SUMS-1.4.0.txt`，8 个 ZIP 条目逐文件 SHA-256 一致。
- 当前状态：本次开发、验证和本地交付完成，无剩余必需事项。详细证据见本地 `docs/test.md` 与 `.tmp/temporary-1.4.0-package-verification.json`。
- 风险：临时 URL 不依赖生产环境标记，发送前须由用户确认目标；取消不能撤销服务器操作。无数据库迁移；本次不操作已安装程序、业务数据或 GitHub。
