# 环境隔离、自动保存与颜色配置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 按用户已批准方案实现环境请求/响应隔离、切换自动保存与项目环境自定义颜色。

**Architecture:** 接口元数据共享，RequestDefinition.environmentConfigs 按环境 ID 保存完整执行配置。响应以 requestId/environmentId 独立加密持久化，不进入工作区交换文件；保存配置仍用原 revision CAS 事务。前端串行保存再切换，保存失败原地保留草稿。

**Tech Stack:** React/TypeScript、Tauri/Rust、SQLite、Windows DPAPI、Vitest。

## 已确认与边界
- 用户批准推荐方案，仍处自测阶段，旧数据仅保留基础兼容，不做历史恢复。
- 保留原 docs/test.md 未提交内容；不触碰 Yaak 源数据，不上传私有数据，不发送真实业务请求。
- 共享接口 id/name/serviceId/folderId/method/path；隔离 query/headers/auth/bodyType/body/form/timeoutMs。
- 旧字段只作为缺省模板，编辑任何已选环境只写 environmentConfigs；无环境不能编辑执行配置。
- service 公共 headers/auth 仍保持默认继承，接口各环境可覆盖；变量原作用域保持兼容。
- response 最新一条/接口/环境，DPAPI 加密，支持清除；单条有大小限制。

## 统一契约
```ts
export type RequestConfig = Pick<RequestDefinition, 'query'|'headers'|'auth'|'bodyType'|'body'|'form'|'timeoutMs'>;
// RequestDefinition.environmentConfigs?: Record<string, RequestConfig>
// Project.color?: string; Environment.color?: string; 均为 #RRGGBB，空缺使用默认值。
// api.loadResponse(requestId, environmentId): Promise<ResponseData|null>
// api.saveResponse(requestId, environmentId, response): Promise<void>
// api.clearResponse(requestId, environmentId): Promise<void>
```
原生命令 load_response/save_response/clear_response 使用上述 camelCase 参数；响应不更改 workspace revision。配置保存整表替换时只保留仍有效接口/环境的响应，不被临时 DELETE 级联误删。

## Task 1 — 原生数据边界（独立 Rust 写集）
- [x] 添加失败测试：环境配置往返、颜色校验、错误项目环境拒绝；响应 A/B 隔离、重开恢复、清除、配置保存后保留、级联删除、加密存储。
- [x] src-tauri/src/models.rs 增加可缺省配置/color；migrations/003_environment_configs.sql 升级；store.rs 完成事务验证与持久化，旧 schema 升级前一致性备份。
- [x] lib.rs 注册五个响应/清理 IPC；engine/store 的执行秘密解析使用正确配置。
- [x] 执行 cargo test --locked、fmt、clippy，记录结果。

## Task 2 — 工作区与运行状态（主线程）
- [x] src/lib/environment.ts 与测试：resolveRequest 合并选中配置；updateRequest 只改该环境，共享路径不变；删除环境清理配置。
- [x] hook 回归用例：切换自动保存，保存失败不切换，连续快捷键不重入，保存期间防止编辑丢失，迟到响应按发送环境归属，加载与发送竞争不覆盖新响应。
- [x] src/types.ts、src/lib/ipc.ts、useWorkbench.ts、RequestEditor.tsx 接入配置和响应；关闭标签自动保存。
- [x] 更新旧测试中明确被新需求替代的“确认保存”断言，其他安全验证保留。

## Task 3 — 颜色、快捷键与响应 UI（独立组件写集）
- [x] 新建 ColorSelect 与 ColorPicker，先测键盘选择、对比度不依赖颜色、合法 HEX、关闭恢复焦点。
- [x] EntityManager 添加项目/环境颜色配置；App.tsx 用可读自定义下拉，Ctrl+S 和保存状态；ResponsePanel 支持清除回调。
- [x] 保留生产确认与生产标识；环境组件 key 包含环境，避免编辑器遗留局部状态。

## Task 4 — 文件交换边界（独立 exchange 写集）
- [x] 先测试颜色与环境配置导出/导入、ID 重映射、凭据脱敏和文件清除、重复/无效配置拒绝。
- [x] src/lib/exchange.ts 接入新字段，兼容旧交换文件，响应不导出；环境配置 Pair ID 采用各配置局部唯一语义。

## Task 5 — 综合验收
- [x] npm test、npm run build、cargo test --locked、cargo fmt --check、cargo clippy --all-targets -- -D warnings。
- [x] 检查版本说明、数据 schema 回滚：保留备份，用旧程序恢复旧备份，不执行逆向 DROP 导致丢数。
- [x] 独立评审需求与竞态，修复后重跑；更新 docs/test.md（仅合成数据）。
- [x] 构建本机可运行产物；不擅自覆盖运行中进程或丢弃用户草稿。

## 执行中补充（用户要求空间清理，已纳入本轮）
- 清理入口在工作区管理：默认清所有响应缓存，可选清所有请求正文和表单值，明确二次确认，不删除接口及其他执行配置。
- response 总上限64MiB（按序列化数据计）、单条8MiB（JSON元数据整体），覆盖或最旧淘汰，不累积历史；DPAPI密文保存。
- clear_responses()/compact_storage() 分离；先清数据再 VACUUM 和 WAL checkpoint，失败明确提示；响应清理不影响 workspace revision。
- 清理不得趁请求运行中执行；保持生产发送确认和已存在备份，不操作 Yaak 数据。
- 版本统一0.3.0，构建产物为未签名开发预览。

## 阶段记录
已确认：前端原先共享请求体，响应按requestId而非环境索引。
已完成：环境配置隔离、静默自动保存、颜色配置、加密最新响应缓存与64MiB容量控制、可选清正文与空间回收；全量470项自动化通过，原生UI合成数据验收、独立审查、最终打包与本机升级通过。
未完成：无本轮实施遗留项。真实业务联调/压力/断电与多系统矩阵未执行，边界记录在 docs/test.md；未提交推送GitHub。
风险：保存时需要完整工作区校验，任意无效草稿会阻止切换；不会绕过校验或丢弃草稿。响应含敏感信息，故仅加密本地保存。
本机：运行目录已替换0.3.0，原快捷方式不变；自动备份后schema 2→3，83接口和revision 12保留，12张旧表原列摘要一致。详细验证、恢复路径和最终产物校验见 docs/test.md 的 ENV-CACHE-1003。
