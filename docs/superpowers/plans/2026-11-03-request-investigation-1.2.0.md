# 请求排查扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 按下列任务执行与审查，用户已授权实施。

**Goal:** 在 1.2.0 中完成会话时间线、可验证的网络诊断及脱敏 HTML 排查包。

**Architecture:** 现有发送 Hook 捕获不可变快照，受限会话内存保存；原生详细命令增加测量；懒加载时间线窗口组合查看、恢复、已有 JSON 对比与导出。

**Tech Stack:** React 19、TypeScript、Tauri 2、Rust、Vitest；不增加依赖。

**Spec:** `docs/superpowers/specs/2026-11-03-request-investigation-1.2.0-design.md`

## Global Constraints

- 版本保持 1.2.0，保留所有已有未提交改动。
- 无数据库迁移、无真实业务接口调用、不自动发送回放、不安装、不推送。
- 历史最多 50 条、16 MiB；仅会话内存。
- JSON 工具数据规则不变，测量结果不得伪称 DNS/TLS 分段。

## Task 1：原生测量与兼容命令

Files: `src-tauri/src/models.rs`、`engine.rs`、`engine/transport.rs`、`lib.rs` 及对应原生测试。

Consumes: `src/types.ts` 的 RequestDiagnostics / DetailedExecutionResult 契约。
Produces: `send_request_detailed(input)`，序列化 `{response?,error?,diagnostics}`；旧发送 API 保留。

- [x] 先写回环 HTTP、连接失败、取消、超时、旧缓存兼容测试；运行确认缺少行为。
- [x] 实现固定错误分类及安全测量，复用原传输策略。
- [x] 运行新增及原生全量测试，确认不泄漏真实凭据 URL。

## Task 2：会话记录与草稿恢复

Files: `src/lib/request-history.ts`、测试、`src/hooks/useWorkbench.ts`、Hook 测试、`src/lib/ipc.ts`。

Interfaces: `appendHistory(entries, entry)` 返回容量受限的新列表；`restoreHistoryDraft(workspace, entry)` 返回新工作区或抛出已删除上下文错误。`RequestExecutionError` 提供安全 message 与 diagnostics。

- [x] 先覆盖独立快照、容量淘汰、超大条目、环境恢复、文件清空测试。
- [x] 使用发送前捕获的请求；移除 environmentConfigs，记录结束后的响应/错误。
- [x] 恢复前自动保存当前草稿，再定位原项目/环境/接口，应用到该环境草稿；不恢复临时变量。
- [x] 清空操作使用 generation 避免晚到请求重新填充已清空记录；删除仅移除选定的已完成条目。
- [x] 原接口发送/保存/生产确认的历史测试继续通过。

## Task 3：脱敏 HTML 排查包

Files: `src/lib/investigation-report.ts`、测试。

Interfaces: `buildInvestigationReport(entry, options)` 返回 `{html, preview}`；选项包含现象、复现步骤以及是否包含请求正文、响应正文和响应 Headers。

- [x] 先覆盖默认不带正文、嵌套凭据脱敏、HTML 注入、大整数保留、非 JSON 省略测试。
- [x] 严格边界处理，静态 HTML、CSP、脱敏模板 cURL，不携带变量值或文件路径。
- [x] 最终预览与下载共用同一输出，所有用户文字转义。

## Task 4：窗口与诊断界面

Files: `src/components/RequestHistoryDialog.tsx`、`RequestDiagnosticsPanel.tsx`、`request-history.css`、组件测试、`src/components/ResponsePanel.tsx`、`src/App.tsx`。

- [x] 先覆盖空状态、筛选、查看、选两条比较、草稿恢复及导出预览测试。
- [x] 左侧增加时间线入口，懒加载弹窗；原生 dialog 的 Esc/焦点语义沿用现有组件。
- [x] 当前响应执行详情展示测量；旧响应缺指标显示未采集。
- [x] 支持窄/矮窗口滚动，使用现有主题变量和内容语义颜色。

## Task 5：独立审查、回归与文档

Files: README、1.2.0 版本说明、本机忽略的 `docs/test.md`。

- [x] 审查新增代码，修复确认缺陷并增加复现测试。
- [x] `npm test -- src --maxWorkers=2`、`npm run build`、`npm run test:packaging`。
- [x] `. ./scripts/env.ps1; cargo test --manifest-path src-tauri/Cargo.toml --locked`。
- [x] 核对版本不变，Git 差异无异常空白，记录功能限制与测试结果。

本轮结果：前端 878 项、原生 163 项、打包兼容 11 项通过；生产构建及 7 组生产页面合成 IPC 验收通过，导出 HTML 另经实际渲染检查。独立前端与原生审查收尾完成，F1–F6 及追加的 URL 规范化脱敏遗漏均已关闭。完整证据见本机忽略的 `docs/test.md`。不包含安装、发布或真实系统保存框点选验收。
