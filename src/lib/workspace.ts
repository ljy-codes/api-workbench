import type { RequestDefinition, ResponseData, Workspace } from '../types';

export const uid = (): string => crypto.randomUUID();
export const emptyWorkspace = (): Workspace => ({
  revision: 0, activeProjectId: null, projects: [], environments: [], services: [],
  bindings: [], folders: [], requests: [], variables: [],
});
export const newRequest = (serviceId: string, folderId: string | null = null, id = uid()): RequestDefinition => ({
  id, serviceId, folderId, name: '新建接口', method: 'GET', path: '/',
  query: [], headers: [], bodyType: 'none', body: '', timeoutMs: 30000,
});
export type EntityKind = 'project' | 'environment' | 'service' | 'folder' | 'request';

export function cascadeDelete(workspace: Workspace, kind: EntityKind, id: string): Workspace {
  const w = structuredClone(workspace);
  const projects = new Set(kind === 'project' ? [id] : []);
  const services = new Set(w.services.filter(s => projects.has(s.projectId) || (kind === 'service' && s.id === id)).map(s => s.id));
  const environments = new Set(w.environments.filter(e => projects.has(e.projectId) || (kind === 'environment' && e.id === id)).map(e => e.id));
  const folders = new Set(w.folders.filter(f => services.has(f.serviceId) || (kind === 'folder' && f.id === id)).map(f => f.id));
  let size = -1;
  while (size !== folders.size) {
    size = folders.size;
    w.folders.forEach(f => { if (f.parentId && folders.has(f.parentId)) folders.add(f.id); });
  }
  const requests = new Set(w.requests.filter(r => services.has(r.serviceId) || (r.folderId && folders.has(r.folderId)) || (kind === 'request' && r.id === id)).map(r => r.id));
  const bindings = new Set(w.bindings.filter(b => projects.has(b.projectId) || services.has(b.serviceId) || environments.has(b.environmentId)).map(b => b.id));
  const removed = { project: projects, service: services, environment: environments, binding: bindings, request: requests };
  w.projects = w.projects.filter(p => !projects.has(p.id)).map(p => ({ ...p, activeEnvironmentId: p.activeEnvironmentId && environments.has(p.activeEnvironmentId) ? null : p.activeEnvironmentId }));
  w.services = w.services.filter(s => !services.has(s.id));
  w.environments = w.environments.filter(e => !environments.has(e.id));
  w.folders = w.folders.filter(f => !folders.has(f.id));
  w.requests = w.requests.filter(r => !requests.has(r.id));
  w.bindings = w.bindings.filter(b => !bindings.has(b.id));
  w.variables = w.variables.filter(v => !projects.has(v.projectId) && !removed[v.scope].has(v.ownerId));
  if (w.activeProjectId && projects.has(w.activeProjectId)) w.activeProjectId = w.projects[0]?.id ?? null;
  return w;
}

export function variableOwners(w: Workspace, projectId: string, environmentId: string | null, request?: RequestDefinition) {
  const binding = w.bindings.find(b => b.serviceId === request?.serviceId && b.environmentId === environmentId);
  return [
    { scope: 'project' as const, ownerId: projectId, label: '项目' },
    { scope: 'service' as const, ownerId: request?.serviceId ?? '', label: '服务' },
    { scope: 'environment' as const, ownerId: environmentId ?? '', label: '环境' },
    { scope: 'binding' as const, ownerId: binding?.id ?? '', label: '服务 × 环境' },
    { scope: 'request' as const, ownerId: request?.id ?? '', label: '接口' },
  ];
}
export const responseForExecution = (executionId: string, response: ResponseData) => response.executionId === executionId ? response : null;
export const errorMessage = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : '操作失败，请重试。';
export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export function demoWorkspace(): Workspace {
  const w = emptyWorkspace();
  w.activeProjectId = 'demo-project';
  w.projects = [{ id: 'demo-project', name: '星河 · 开放平台', activeEnvironmentId: 'demo-dev' }];
  w.environments = [{ id: 'demo-dev', projectId: 'demo-project', name: '开发环境', isProduction: false }, { id: 'demo-prod', projectId: 'demo-project', name: '生产环境', isProduction: true }];
  w.services = [{ id: 'demo-users', projectId: 'demo-project', name: '用户服务' }, { id: 'demo-orders', projectId: 'demo-project', name: '订单服务' }];
  w.bindings = [{ id: 'demo-binding', projectId: 'demo-project', serviceId: 'demo-users', environmentId: 'demo-dev', baseUrl: 'https://api.example.com/v1', enabled: true }];
  w.folders = [{ id: 'demo-folder', serviceId: 'demo-users', parentId: null, name: '用户管理' }];
  w.requests = [{ ...newRequest('demo-users', 'demo-folder', 'demo-list'), name: '获取用户列表', path: '/users', query: [{ id: 'demo-query', key: 'page', value: '1', enabled: true }] }, { ...newRequest('demo-users', 'demo-folder', 'demo-create'), name: '创建用户', method: 'POST', path: '/users', bodyType: 'json', body: '{\n  "name": "示例用户"\n}' }];
  return w;
}
