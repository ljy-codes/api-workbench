# M1/M2 共享契约

所有 TS 字段为 camelCase，Rust serde(rename_all="camelCase")。字符串 ID，ID 不为空。顶层 Workspace 默认空列表、revision=0、activeProjectId=null。

```typescript
type Pair = { id: string; key: string; value: string; enabled: boolean };
type Project = { id: string; name: string; activeEnvironmentId: string | null };
type Environment = { id: string; projectId: string; name: string; isProduction: boolean };
type Service = { id: string; projectId: string; name: string };
type Binding = { id: string; projectId: string; serviceId: string; environmentId: string; baseUrl: string; enabled: boolean };
type Folder = { id: string; serviceId: string; parentId: string | null; name: string };
type RequestDefinition = {
 id: string; serviceId: string; folderId: string | null; name: string; method: string; path: string;
 query: Pair[]; headers: Pair[]; bodyType: 'none'|'json'|'text'; body: string; timeoutMs: number;
};
type Variable = { id: string; projectId: string; scope: 'project'|'service'|'environment'|'binding'|'request'; ownerId: string; name: string; value: string; isSecret: boolean };
type Workspace = { revision: number; activeProjectId: string | null; projects: Project[]; environments: Environment[]; services: Service[]; bindings: Binding[]; folders: Folder[]; requests: RequestDefinition[]; variables: Variable[] };
type ExecuteInput = { executionId: string; environmentId: string; request: RequestDefinition; temporaryVariables: Pair[]; productionConfirmed: boolean };
type Preview = { url: string; environmentName: string; serviceName: string; isProduction: boolean; resolvedVariables: {name:string; value:string; source:string; isSecret:boolean}[] };
type ResponseData = { executionId: string; status: number; statusText: string; durationMs: number; sizeBytes: number; headers: Pair[]; body: string; truncated: boolean; environmentName: string; url: string };
```

IPC：
- `load_workspace()` → Workspace（秘密值空字符串）。
- `save_workspace({workspace})` → Workspace（CAS revision，保存后加一；返回遮罩秘密）。
- `preview_request({input})` → Preview（秘密显示为 `••••••`）。
- `send_request({input})` → ResponseData（明确失败 reject 字符串，不带秘密）。
- `cancel_request({executionId})` → void。
- `app_info()` → `{dataDir:string, version:string, portable:boolean}`。

Rust 集成接口：
- `Store::open(path: &Path) -> Result<Store, String>`；Store 持 `Mutex<Connection>`，可作为 Tauri state 使用。
- `Store::load() -> Result<Workspace, String>` 给 UI，遮罩秘密。
- `Store::load_for_request(input: &ExecuteInput) -> Result<Workspace, String>` 只在一致快照内解密当前请求实际需要的生效变量。
- `Store::load_for_execution()` 只保留用于旧测试，不允许 IPC 发送路径使用全库解密。
- `Store::save(workspace: Workspace) -> Result<Workspace, String>`，事务与 revision 检查。
- `engine::preview(workspace: &Workspace, input: &ExecuteInput) -> Result<Preview,String>`。
- `engine::execute(workspace: &Workspace, input: ExecuteInput, cancel: tokio_util::sync::CancellationToken) -> Result<ResponseData,String>` async。

Store 与 engine 依赖共享 `crate::models::*`；各 agent 不修改共享模型，变更请先通知主任务。

上方是 0.1 基础 DTO。0.2 的兼容扩展以 `src/types.ts`、`src-tauri/src/models.rs` 及 `docs/superpowers/plans/2026-10-03-v02.md` 为准：Service.headers/auth、RequestDefinition.auth/form、form/multipart bodyType，缺省新字段兼容旧 JSON。

新增 IPC：`pick_upload_file()`、`read_project_file()`、`write_project_file({content})`、`export_curl({input})`、`backup_workspace()`，前端签名见 `src/lib/ipc.ts`。文件路径仅原生选择器产生，导入内容不能指定写入位置。文件读写上限 10 MiB；备份仅包含已保存配置。

范围说明：0.2 增加服务公共 Headers 和三种鉴权继承；重定向可配置、完整历史、脚本仍未实现。接口只能执行本项目服务下定义，不允许输入 DTO 绕过归属检查。
