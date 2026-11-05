export interface Pair { id: string; key: string; value: string; enabled: boolean }
export interface Project { id: string; name: string; activeEnvironmentId: string | null; color?: string }
export interface Environment { id: string; projectId: string; name: string; isProduction: boolean; color?: string }
export interface AuthConfig { kind: "none" | "bearer" | "basic" | "apiKey"; token?: string; username?: string; password?: string; key?: string; value?: string; location?: "header" | "query" }
export interface FormField { id: string; key: string; value: string; enabled: boolean; kind: "text" | "file" }
export interface Service { id: string; projectId: string; name: string; headers?: Pair[]; auth?: AuthConfig | null }
export interface Binding { id: string; projectId: string; serviceId: string; environmentId: string; baseUrl: string; enabled: boolean }
export interface Folder { id: string; serviceId: string; parentId: string | null; name: string }
export interface RequestDefinition {
  id: string; serviceId: string; folderId: string | null; name: string; method: string; path: string;
  query: Pair[]; headers: Pair[]; bodyType: "none" | "json" | "text" | "form" | "multipart"; body: string; timeoutMs: number;
  auth?: AuthConfig | null; form?: FormField[];
  environmentConfigs?: Record<string, RequestConfig>;
}
export type RequestConfig = Pick<RequestDefinition, 'query' | 'headers' | 'auth' | 'bodyType' | 'body' | 'form' | 'timeoutMs'>;
export type VariableScope = "project" | "service" | "environment" | "binding" | "request";
export interface Variable { id: string; projectId: string; scope: VariableScope; ownerId: string; name: string; value: string; isSecret: boolean }
export interface Workspace {
  revision: number; activeProjectId: string | null; projects: Project[]; environments: Environment[];
  services: Service[]; bindings: Binding[]; folders: Folder[]; requests: RequestDefinition[]; variables: Variable[];
}
export interface ExecuteInput {
  executionId: string; environmentId: string; request: RequestDefinition;
  temporaryVariables: Pair[]; productionConfirmed: boolean;
}
export interface ResolvedVariable { name: string; value: string; source: string; isSecret: boolean }
export interface Preview { url: string; environmentName: string; serviceName: string; isProduction: boolean; resolvedVariables: ResolvedVariable[] }
export interface ResponseData {
  executionId: string; status: number; statusText: string; durationMs: number; sizeBytes: number;
  headers: Pair[]; body: string; truncated: boolean; environmentName: string; url: string;
  diagnostics?: RequestDiagnostics;
}
export interface RequestDiagnostics {
  outcome: 'response' | 'timeout' | 'cancelled' | 'connection' | 'body' | 'validation' | 'transport';
  totalMs: number;
  preparationMs?: number;
  headersMs?: number;
  downloadMs?: number;
  remoteAddress?: string;
  httpVersion?: string;
  receivedBytes?: number;
}
export interface DetailedExecutionResult {
  response?: ResponseData | null;
  error?: string | null;
  diagnostics: RequestDiagnostics;
}
export interface RequestHistoryEntry {
  id: string; projectId: string; projectName: string;
  environmentId: string; environmentName: string; serviceName: string;
  startedAt: number; finishedAt: number; url: string;
  request: RequestDefinition; temporaryVariables: Pair[];
  response?: ResponseData; error?: string; diagnostics?: RequestDiagnostics;
}
export interface AppInfo { dataDir: string; version: string; portable: boolean }
