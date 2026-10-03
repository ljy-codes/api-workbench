# 接口工具 · API Workbench

Windows 优先的纯本地接口调试工具。当前为 **0.2.0 增强预览版**，不是完整 Postman 替代发行版。

## 基本模型

项目 → 服务 → 目录/接口。环境作为项目级运行配置，服务在每个环境单独配置基础地址。接口定义共用，切换环境不复制接口。

运行数据由 Rust 使用 SQLite 保存；敏感变量通过 Windows DPAPI 保护。无账号、云同步、遥测、远程日志或自动更新。

## 开发启动

要求 Node.js、Rust MSVC 工具链、MSVC C++ Build Tools、Windows SDK 和 WebView2 Runtime。

脚本优先使用本项目 `.tools` 下的隔离 Rust；没有隔离工具链时使用 PATH 中的 Rust。Git 仓库不包含工具链和依赖缓存。请先安装 Node.js、Rust MSVC 工具链，以及包含 C++ 桌面开发组件的 Visual Studio Build Tools / Windows SDK。脚本只修改当前进程环境。

```powershell
cd D:\专用工具\接口工具\开发空间
npm ci
.\scripts\dev.ps1
```

仅查看前端：

```powershell
npm run dev
```

访问终端显示的本机地址。浏览器模式是**仅内存预览**，不支持实际持久化或发送请求，也不会用 localStorage 冒充 SQLite。

## 测试

```powershell
.\scripts\test.ps1
```

分别执行：

```powershell
npm test
npm run build
. .\scripts\env.ps1
cargo test --manifest-path src-tauri/Cargo.toml
```

测试只使用临时数据库和回环 HTTP 服务，不调用生产接口。

## 0.2 工作台

- 多请求标签页：关闭标签不删除接口，也不丢弃工作区草稿。
- 当前项目接口搜索：名称、路径、方法、服务名；面板支持拖动和键盘调整。
- 服务公共 Headers；按变量展开后的名称匹配，接口同名 Header 覆盖服务同名组（ASCII 大小写无关），接口重复 Header 保留。
- 请求鉴权支持继承服务、无鉴权、Bearer、Basic、API Key（Header / Query）。
- JSON、文本、URL 编码表单与 multipart 文件上传。
- 原生变量解析预览：查看最终脱敏 URL、变量来源和覆盖结果。
- 响应格式化、文本搜索；只显示文本，不执行响应中的 HTML/脚本。
- cURL 解析导入、脱敏 cURL 复制；项目交换文件导入导出、一致性 SQLite 备份。

### 凭据与文件

鉴权的 Token、密码、API Key 值只填写完整变量引用，例如 `{{accessToken}}`。实际值到变量配置中填写并**勾选“敏感”**，才会由 DPAPI 加密保存；普通变量、普通 Headers 和 Body 不自动加密。引用本身不等于加密。

请求 `auth=null` 继承服务；显式“无鉴权”禁用继承。鉴权生成的 Header / Query 与手工参数同名时拒绝发送，避免悄悄覆盖。

文件须通过本地选择器明确选取；单文件最多 10 MiB，总文件内容最多 20 MiB。只接受普通文件，不接受符号链接/重解析点。请求前预览和复制 cURL 不读取文件。导入项目中的文件路径会清空、文件项禁用，需重新选择。

### 数据交换

工作区管理中导入项目文件或粘贴项目 JSON。导入分配全新 ID，不覆盖已有项目；结果是未保存草稿，确认后再保存。cURL 导入要求先选项目与环境，生成新服务及其当前环境绑定，不改变现有服务地址。

只解析支持的 cURL 语法，**绝不执行命令**；不支持的参数会明确报错。导出的 cURL 是 POSIX shell 格式，不是 PowerShell 命令，敏感值与文件路径为占位内容，使用前需手工补齐。

cURL HEAD 使用 `--head`；HEAD 同时配置正文时拒绝导出，避免生成 cURL 无法执行的参数组合。导入导出不能保证签名 URL 的原始字节完全不变，此类请求请人工核对编码。

项目交换默认移除敏感变量值和已知凭据参数，导入后需重新填写。**自由格式 Body、自定义 Header、普通变量仍可能包含业务隐私，导出前必须人工检查。** 项目交换文件不是完整凭据备份。

## 数据目录与升级

- 常规构建：`%LocalAppData%\ApiWorkbench\app.db`。
- `portable` 构建：EXE 旁 `ApiWorkbenchData\app.db`。
- `app.db-wal`、`app.db-shm` 是 SQLite 工作文件，运行中不能仅复制主数据库当备份。
- 0.2 使用 schema v2。首次打开 v1 数据库前，自动以 SQLite backup API 在数据目录 `backups` 下生成一致性备份，然后事务迁移；备份失败停止升级，未知版本拒绝打开。
- 工作区管理中的备份按钮只备份**已保存**数据，不含当前草稿。备份文件包含普通配置明文和 DPAPI 密文，需要按私有文件保护。
- 回退：关闭所有实例，单独保留完整 v2 数据目录；把升级前备份恢复到另一个目录，配合 0.1 程序使用。不要直接用 0.1 打开 v2，也不要对线上库执行 DROP/手工降级；v2 新字段无法无损转换为 v1。
- 跨电脑或 Windows 用户后 DPAPI 凭据可能无法解密，需要重新输入，不会明文兜底。

## 当前操作方式

1. 新建项目和环境。
2. 新建服务，打开环境矩阵填写各环境基础地址。
3. 新建接口，填写方法与相对路径，例如 `/users/{{userId}}`。
4. 配置变量、Query、Headers、鉴权或请求 Body。
5. 保存工作区，再预览或发送请求。
6. 查看状态码、耗时、已接收大小、Headers 与响应正文。

生产环境发送需明确确认。没有环境绑定时禁止发送；取消仅停止客户端等待，不代表服务端撤销操作。

## 当前限制

- 请求引擎先支持 HTTP/1，不支持系统代理或可配置代理；TLS 校验开启，不能跳过证书校验。
- 不自动跟随重定向，不自动重试。响应只在内存展示，不保存历史正文。
- 响应正文预览上限 2 MiB，越界后停止继续接收；“已接收大小”不代表完整响应大小。非 UTF-8 字节以替代字符展示，不适合二进制下载。
- JSON 变量只支持字符串值，不支持键名或裸 JSON 结构占位符。
- 尚无 OAuth 流程、完整历史、Postman/OpenAPI 导入、备份恢复 UI、脚本、接口串联和批量测试。
- 编辑布局先提供深色主题，浅色主题后续补充。
- 数据格式与 IPC 尚处开发阶段；不要把当前唯一副本的生产凭据或重要请求集只存于此工具。

## 便携预览构建

```powershell
.\scripts\build-preview.ps1
```

输出 `publish\接口工具-0.2.0-preview`，包含 EXE、说明和 SHA-256 校验文件。是未签名的开发预览构建，需要本机已有 WebView2 Runtime；不内置在线更新。直接运行 EXE 即可，数据保存在 EXE 旁。

本机回环验收服务（可选）：

```powershell
node scripts/smoke-server.mjs
```

仅监听 `127.0.0.1:18765`，可使用 `/health`、`/echo`、`/delay` 路径，不需要外部业务服务器。

## 项目结构

`src`：React UI；`src-tauri/src`：原生引擎、IPC、存储；`src-tauri/migrations`：数据库 SQL；`scripts`：启动/测试/构建；`docs`：计划、契约与测试记录。

实现与测试进度见 `docs/test.md`，整体设计见 `docs/总体方案.md`，本轮范围见 `docs/superpowers/plans/2026-10-03-v02.md`。总体方案中的未来能力不等于当前已实现功能。
