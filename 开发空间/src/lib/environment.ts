import type { RequestConfig, RequestDefinition, Workspace } from '../types';

const configKeys = ['query', 'headers', 'auth', 'bodyType', 'body', 'form', 'timeoutMs'] as const;
const sharedKeys = ['name', 'method', 'path'] as const;

export function executionKey(requestId: string, environmentId: string | null): string {
  return JSON.stringify([requestId, environmentId]);
}

export function resolveRequest(request: RequestDefinition, environmentId: string | null): RequestDefinition {
  const config = environmentId && Object.hasOwn(request.environmentConfigs ?? {}, environmentId)
    ? request.environmentConfigs![environmentId] : null;
  return config ? { ...request, ...config, auth: config.auth, form: config.form } : request;
}

export function updateEnvironmentRequest(workspace: Workspace, requestId: string, environmentId: string | null, patch: Partial<RequestDefinition>): Workspace {
  const request = workspace.requests.find(r => r.id === requestId);
  if (!request) return workspace;
  const hasConfig = configKeys.some(key => Object.hasOwn(patch, key));
  const service = workspace.services.find(s => s.id === request.serviceId);
  if (hasConfig && !workspace.environments.some(e => e.id === environmentId && e.projectId === service?.projectId)) {
    throw new Error('请先选择此接口所属项目的环境，再编辑请求配置。');
  }
  const shared = Object.fromEntries(sharedKeys.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
  const effective = resolveRequest(request, environmentId);
  const config = structuredClone(Object.fromEntries(configKeys
    .map(key => [key, Object.hasOwn(patch, key) ? patch[key] : effective[key]])
    .filter(([, value]) => value !== undefined))) as RequestConfig;
  return { ...workspace, requests: workspace.requests.map(r => r.id !== requestId ? r : {
    ...r, ...shared,
    ...(hasConfig ? { environmentConfigs: { ...r.environmentConfigs, [environmentId!]: config } } : {}),
  }) };
}

export function cleanRequestBodies(workspace: Workspace): Workspace {
  const clean = <T extends RequestConfig>(config: T): T => ({
    ...config, body: '',
    ...(config.form ? { form: config.form.map(f => ({ ...f, value: '', enabled: f.kind === 'file' ? false : f.enabled })) } : {}),
  });
  return { ...workspace, requests: workspace.requests.map(r => ({
    ...clean(r),
    ...(r.environmentConfigs ? { environmentConfigs: Object.fromEntries(Object.entries(r.environmentConfigs).map(([id, config]) => [id, clean(config)])) } : {}),
  })) };
}
