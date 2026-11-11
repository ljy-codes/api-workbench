# Cloud Sync Probe Implementation Plan

> **For agentic workers:** Execute this user-authorized validation in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立试验验证“云端文件夹创建 → 两台设备接入 → 双向同步与冲突保护”，明确百度和夸克官方接入边界。

**Architecture:** 主程序维持原状；在 `experiments/cloud-sync/` 中使用 Node.js 标准库实现小型 WebDAV 客户端、加密快照协议和仅监听回环地址的测试服务器。所有数据均为虚构工作区，真实提供方只查询官方资料和静态发布内容。

**Tech Stack:** Node.js 标准库 `node:test`、`node:crypto`、`node:http`，Fetch API；不添加 npm/Cargo 依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-cloud-sync-probe-design.md`

## Global Constraints

- 版本保持 1.0.0。
- 不读取真实数据库、真实网盘凭据或浏览器登录状态。
- 不修改现有未提交文件；不启动第三方发布包。
- 试验不接入主应用、不发布安装器、不执行 Git 提交。
- 测试 HTTP 服务仅监听 `127.0.0.1`，默认拒绝明文远程连接。

## Task 1: Provider evidence and fixture

**Files:** `experiments/cloud-sync/fixture-server.mjs`、`experiments/cloud-sync/README.md`。

**Interfaces:**
- Produces: `startFixture(): Promise<{ url, records, faults, close }>`，用于模拟 WebDAV 的 MKCOL、PROPFIND、GET、PUT、ETag 和条件写入。
- `faults` 允许一次性注入 PUT 错误、缺少 ETag、并发版本变化；只用于测试。

- [x] 查询百度、夸克官方授权说明，记录精确来源和验证边界。
- [x] 尝试下载官方夸克发布包；网络不可用，已记录 TLS EOF，未读取包内容、未换镜像。
- [x] 构建回环服务，对错误认证返回 401，对条件不匹配返回 412。
- [x] 确保目录创建幂等且目录列表可区分已有同步目录。

## Task 2: Tests first, protocol second

**Files:** `experiments/cloud-sync/cloud-sync.test.mjs`、`experiments/cloud-sync/protocol.mjs`。

**Interfaces:**
- Consumes: `startFixture()`。
- Produces: `CloudFolder`，构造参数含 `url`、`username`、`password`、`allowLoopbackHttp`。
- `CloudFolder.create(folder, syncPassword, workspace)` 创建同步空间。
- `CloudFolder.join(folder, syncPassword)` 接入同步空间，返回独立设备状态。
- 设备状态提供 `edit(workspace)`、`sync()`，持有 `workspace`、`baseVersion`。
- `CloudFolder.list(folder)` 列出子文件夹。

- [x] 先写以下端到端断言，运行 `node --test experiments/cloud-sync/cloud-sync.test.mjs`，确认缺少协议实现导致失败。

```js
const first = await cloud.create('/EnvDock', 'test-password', example);
const second = await cloud.join('/EnvDock', 'test-password');
assert.deepEqual(second.workspace, first.workspace);
assert.equal(second.workspace.requests[0].id, example.requests[0].id);
first.edit(changed);
assert.equal((await first.sync()).status, 'pushed');
assert.equal((await second.sync()).status, 'pulled');
```

- [x] 增加冲突、密码错误、认证失败、缺失 ETag、重复创建、云端中断及设备字段过滤的可观察行为测试。
- [x] 实现 URL 和路径校验，拒绝非回环 HTTP、查询参数、片段以及路径穿越。
- [x] 实现加密快照，使用 scrypt 派生密钥和 AES-256-GCM，限制明文及加密后文件大小。
- [x] 实现条件写入和共同基础版本检查，失败时保留本地状态。
- [x] 20 项测试全部通过；包括读后并发竞争、服务忽略条件写入和 PUT 202 未完成的反例。

## Task 3: Reproducible demo and findings

**Files:** `experiments/cloud-sync/demo.mjs`、`experiments/cloud-sync/README.md`、`.tmp/cloud-sync-probe-20261027/status.md`。

**Interfaces:** `node experiments/cloud-sync/demo.mjs` 运行一次本地 A/B 设备示例，结束后退出且关闭服务。

- [x] 演示创建文件夹、第二设备接入、A 修改 B 拉取、B 修改 A 拉取和冲突保留。
- [x] 只打印操作名称和同步状态，不打印密码、凭据或业务正文。
- [x] 记录正式接入尚需的应用审核、Windows 验证、真实云端读写、扩展签名和 UI 工作。
- [x] 检查 `git diff --stat` 及 `git status --short`，原有 4 个已跟踪修改文件及复制测试保持原样。
- [x] 将完成证据及未完成项写入阶段记录，明确“试验通过”不等于“正式功能已安装”。

## 运行证据

- 测试：`.tmp/cloud-sync-probe-20261027/test.log`，20 项通过，0 项失败。
- 演示：`.tmp/cloud-sync-probe-20261027/demo.log`，5 步完成，服务随后关闭。
- 导入与冲突文件：`.tmp/cloud-sync-probe-20261027/demo/`，仅包含虚构数据。
- 原应用依赖、锁文件、Tauri 配置均无本轮改动；没有新增主程序入口引用。
- 审查修复：HTTP PUT 202 不再被当成提交完成；两个回归用例均先失败、修复后通过。
