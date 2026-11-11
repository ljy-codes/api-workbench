# EnvDock 1.4.0 临时请求 Rust 执行链

日期：2026-11-10

已实现 Task1。核心是无环境、无已保存请求时也能直接发送；沿用专用 IPC 和自然内存数据，不增加擦除或防痕机制。

## 接口与行为

- `TemporaryExecuteInput { execution_id, request: TemporaryRequest }`；Rust 使用 snake_case、JSON 使用 camelCase，`auth`/`form` 可省略。
- `preview_temporary_request(input) -> Result<Preview, String>`；不接收 AppState。
- `send_temporary_request(input, state) -> DetailedExecutionResult`；仅使用共享执行管理器，复用 `cancel_request`，执行结束释放 ID。
- 临时准备/发送链路不调用 Store，不读取项目、环境、绑定或变量；无需数据库快照。
- 支持完整 HTTP/HTTPS URL、原有 Query 与重复追加参数；保留现有查询编码，追加值按字面编码一次。
- URL 预览与响应 URL 对敏感 Query 脱敏，包括原 URL 中经过编码的敏感键，以及自定义 Query API Key。错误只返回固定提示，不回显 URL、正文、凭据或文件路径。
- 临时鉴权支持直接 Bearer、Basic、Header/Query API Key，不继承服务凭据。所有 `{{...}}` 作为字面值，JSON 字符串及键名不解析变量。
- 支持 none/text/json/form/multipart；multipart 文件读取继续使用原生上传限制和取消机制，预览不读取文件。
- 原 transport 保持整体超时 1～300000 ms、2 MiB 响应预览上限、取消、TLS 校验、禁止跳转及禁止透明重试。

## 修改文件

全部代码修改位于 `src-tauri/src/`：

- `models.rs`：新增固定临时请求契约。
- `lib.rs`：注册两个专用 IPC；仅克隆执行管理器。
- `engine.rs`：临时执行入口，复用计时、取消、deadline、transport 和诊断结果。
- `engine/temporary.rs`（新增）：独立 URL 校验、字面参数准备与展示 URL 脱敏。
- `engine/body.rs`（新增）：抽取普通与临时请求共用的正文/表单校验与组装。
- `engine/prepare.rs`：调用共用正文组装；普通 context、变量保护与鉴权校验保留。
- `engine/auth.rs`：共用鉴权组装，独立提供仅临时入口使用的直接凭据适配器；普通 `protect()` 及凭据引用约束保留。
- `engine/url_builder.rs`：仅调整已有路径歧义校验函数的模块可见性，供临时入口复用。
- `engine/tests.rs`、`command_tests.rs`：挂载临时测试模块。
- `engine/tests/temporary.rs`、`command_tests/temporary.rs`（新增）：11 个测试，覆盖真实回环 HTTP 及命令边界。

未修改版本、Cargo 配置、前端、迁移或 Store 实现；没有执行 commit，也没有派生子代理。并行代理的修改保留。

## 验证证据

先新增测试并运行：

```powershell
. scripts/env.ps1
cargo test --manifest-path src-tauri/Cargo.toml --locked temporary
```

首次退出码 1：`TemporaryExecuteInput`、临时预览和发送入口尚不存在，测试编译失败。实现后执行测试观察行为；修正两个测试夹具：不在已有 WAL 连接存活时切换 journal mode；关闭端口连接测试参照已有 Windows 测试，使用 10000 ms 超时以观察连接拒绝。

完整回归：

```powershell
. scripts/env.ps1
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

结果：退出码 0，172 个单元测试和 2 个集成测试通过，0 失败；doc tests 为 0。仅有 Windows 链接器创建库文件的提示 warning。

- 回环 HTTP 报文验证方法、编码/重复 Query、重复 Headers、JSON 字面值、所有鉴权类型、text/form/multipart 和文件内容。
- 验证等待响应头/正文的超时与取消、预先取消、执行 ID 重复保护和释放、响应截断及 307 不跟随。
- 命令测试验证空工作区与不可读 Store 时仍可发送；数据库主文件和 WAL 内容未被临时命令改变。
- 普通回归覆盖绝对路径拒绝、项目/服务/环境归属、仅变量引用凭据、环境选择、上传约束、响应缓存和数据库迁移。

## 兼容性与注意事项

- 普通接口继续要求已保存身份、合法项目/服务/环境绑定和原有凭据引用；没有放宽普通路径对绝对 URL 的限制。
- URL 拒绝 userinfo、fragment、控制字符、非法百分号、反斜线、路径点段、空主机、经过编码的主机和非标准 IPv4 简写，避免 URL 解析器静默修复改变目标。
- `query` 编辑项是未编码字面值；例如输入 `%2F` 会发送为 `%252F`。完整 URL 中已有 `%2F` 保持其编码语义。
- 共享正文与鉴权组装是主要兼容影响点，完整普通回归已通过。
- 仅完成 Rust Task1；前端交互、版本同步和安装包由主代理负责。
