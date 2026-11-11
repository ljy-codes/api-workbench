# JSON 工具箱 1.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 在现有临时 JSON 窗口扩展双栏对比、转义还原、字段提取，将产品版本升级到 1.2.0。

**Architecture:** 保留原格式化流程，窗口增加四个工具页签；各页组件及纯函数按职责分开。对比复用现有 compareJson / ResponseDiff，增加可保持数字原文的内部表示，避免大整数及小数被 Number 改写。全部草稿、选项和结果只保存在窗口内存。

**Tech Stack:** React 19、TypeScript、CodeMirror 6、Vitest、Tauri 2。

**Spec:** 用户已认可上一轮第一批建议：双栏对比、转义还原、字段批量提取；现有 JSON 工具不保存任何数据。

## Global Constraints

- 不改数据库、IPC、请求发送、响应缓存、凭据、云同步原型及应用标识。
- 不安装新的运行依赖；沿用现有主题和按需加载入口。
- 关闭窗口清空所有工具；清空时同时丢弃相关编辑器撤销历史。
- 格式化既有 null 规则不变；对比、转义和提取不默认去 null。
- 数字不经过 Number 往返；保留长整数、精确小数、字符串转义及对象字段原始顺序。
- 路径支持 `$`、`.name`、`[index]`、`[*]` 及引号字段；不宣称实现完整 JSONPath。
- 明确拒绝不支持的路径语法，显示错误并保留原文；处理上限不输出伪完整结果。
- 版本同步 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 和原生版本验证。
- 已有未跟踪 experiments / cloud-sync 文档保持原样；本次不提交、不推送、不重装本机。

## Task 1: 精确 JSON 与批量提取

**Files:** 新增 `src/lib/json-exact.ts`、`src/lib/json-toolbox.ts` 及对应测试；修改 `src/lib/json-diff.ts` 和对应测试。

**Interfaces:**

```ts
export class ExactNumber { raw: string; canonical: string; }
export function isExactNumber(value: unknown): value is ExactNumber;
export function parseExactJson(source: string): unknown;
export function stringifyExactJson(value: unknown, compact?: boolean): string;
export type ExtractionFormat = 'json' | 'lines' | 'csv' | 'sql';
export function extractJsonValues(source: string, path: string,
  options?: { format?: ExtractionFormat; deduplicate?: boolean }): { text: string; count: number };
export function escapeJsonText(source: string): string;
export function unescapeJsonText(source: string): string;
```

- [x] 先写精度、字段顺序、特殊键、数组通配、SQL 引号、null、去重、无效路径、输入上限的失败测试。
- [x] 运行 `npm test -- src/lib/json-exact.test.ts src/lib/json-toolbox.test.ts src/lib/json-diff.test.ts --maxWorkers=2` 记录失败。
- [x] 实现纯函数，diff 最小接入 ExactNumber 的等价判断、标量识别和按 id 匹配。
- [x] 同命令通过；确保既有响应差异行为保持兼容。

## Task 2: 双栏对比及字符串转换工具

**Files:** 新增 `src/components/JsonCompareTool.tsx`、`JsonStringTool.tsx`、`json-toolbox-panels.css` 及对应测试。

**Interfaces:** 两组件无必填属性，内部草稿全为组件 state。对比调用 `parseExactJson`、`ResponseDiff`；转义调用 `escapeJsonText`、`unescapeJsonText`。

- [x] 先测两侧任意 JSON 对比、错误原文保留、清空撤销隔离、转义往返和剪贴板失败。
- [x] 执行定向测试观察缺失功能，再实现具有可见标签、键盘可操作、结果失效提示的工具。
- [x] 双栏对比显式点击开始，编辑任一输入后隐藏旧结果；字符串转换左右原文/结果预览，复制只复制完整当前结果。
- [x] 保持界面主题变量；窄宽度纵向排列；对比和转义内容不写任何存储或网络。

## Task 3: 主窗口与字段提取

**Files:** 修改 `JsonToolsDialog.tsx`、`json-tools.css`、`ResponseDiff.tsx`；新增 `JsonExtractPanel.tsx` 与测试；扩展 `JsonToolsDialog.test.tsx`、`App.json-tools.test.tsx`。

- [x] 先写页签导航、源内容传给提取、关闭重开清空全部、按需挂载及全程无持久化的测试。
- [x] 增加格式化、双栏对比、转义还原、字段提取四页签，保留原有格式操作及搜索。
- [x] 提取页提供有标签的路径输入、输出格式、去重及只读结果，修改源或选项后不允许复制旧结果。
- [x] ResponseDiff 数字展示识别 ExactNumber，不影响原响应区域默认值展示。
- [x] 定向测试和 TypeScript 构建通过。

## Task 4: 版本、回归及交付

**Files:** 版本元数据、README、`docs/releases/1.2.0-json-toolbox.md`、`docs/test.md`。

- [x] 同步版本，原生测试改为本次发布版本。
- [x] 执行全部前端、打包检查、Rust 测试及生产构建。
- [x] 独立审查精度、路径解析、原型字段、隐私生命周期和老功能兼容；修复确定问题。
- [x] 构建 Windows x64 NSIS 安装包，整理独立 1.2.0 交付目录与 SHA-256，不覆盖旧交付。
- [x] 记录实际验证结果、边界及产物路径。

**完成证据：** 前端 822 项、原生 142 项、打包 11 项，共 975 项通过；正式生产页面 Edge 8 组场景通过，独立复验关闭格式化预算问题。Windows x64 1.2.0 安装器与交付 ZIP 已生成，ZIP 8 文件逐项 SHA-256 一致。详细执行及边界记录于本机 `docs/test.md`。
