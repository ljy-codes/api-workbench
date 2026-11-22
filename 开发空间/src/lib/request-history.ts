import type { Pair, RequestDefinition, RequestHistoryEntry, Workspace } from '../types';
import { resolveRequest, updateEnvironmentRequest } from './environment';

const credentialKey = /auth|cookie|token|secret|passw|passwd|credential|api.?key|access.?key|session|密码|密钥/i;
const variableReference = /^(?:(?:Bearer|Basic)\s+)?\{\{[^{}\r\n]+\}\}$/i;

function restorePairs(historical: Pair[], current: Pair[], apiKeys: Set<string>): Pair[] {
  const normalize = (key: string) => key.trim().toLowerCase();
  const protectedPair = (pair: Pair) => credentialKey.test(pair.key) || pair.key.includes('{{') || apiKeys.has(normalize(pair.key));
  const retained = current.filter(protectedPair);
  const next = historical.flatMap(pair => {
    if (retained.some(value => value.id === pair.id || normalize(value.key) === normalize(pair.key))) return [];
    if (!protectedPair(pair)) return [pair];
    // Variable references resolve against today's values. Unknown historical
    // literal credentials stay visible as disabled, empty fields for review.
    return [{ ...pair, ...(variableReference.test(pair.value) && !pair.key.includes('{{') ? {} : { value: '', enabled: false }) }];
  });
  return structuredClone([...next, ...retained]);
}

export function historyRequestSnapshot(request: RequestDefinition): RequestDefinition {
  // Other environments are unrelated to this execution and can be large.
  const { environmentConfigs: _otherEnvironments, ...snapshot } = request;
  return structuredClone(snapshot);
}

export function appendHistory(entries: RequestHistoryEntry[], entry: RequestHistoryEntry,
  limits = { maxEntries: 50, maxBytes: 16 * 1024 * 1024 }): RequestHistoryEntry[] {
  const bytes = (value: RequestHistoryEntry) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let used = bytes(entry) + 2; // Include JSON array brackets and separators in the budget.
  if (used > limits.maxBytes || limits.maxEntries < 1) return entries;
  const next = [entry];
  for (const previous of entries) {
    if (previous.id === entry.id) continue;
    const size = bytes(previous) + 1;
    if (next.length >= limits.maxEntries || used + size > limits.maxBytes) break;
    next.push(previous);
    used += size;
  }
  return next;
}

export function restoreHistoryDraft(workspace: Workspace, entry: RequestHistoryEntry): Workspace {
  const current = workspace.requests.find(request => request.id === entry.request.id);
  const project = workspace.projects.find(project => project.id === entry.projectId);
  const environment = workspace.environments.find(environment => environment.id === entry.environmentId && environment.projectId === entry.projectId);
  const service = workspace.services.find(service => service.id === entry.request.serviceId && service.projectId === entry.projectId);
  if (!current || !project || !environment || !service) throw new Error('原接口、项目或环境已不存在，无法恢复草稿。');
  if (current.serviceId !== service.id) throw new Error('接口所属服务已变化，无法恢复历史配置。');
  const snapshot = historyRequestSnapshot(entry.request);
  if (snapshot.form) snapshot.form = snapshot.form.map(field => field.kind === 'file' ? { ...field, value: '', enabled: false } : field);
  const effective = resolveRequest(current, entry.environmentId);
  const apiKeys = new Set([snapshot.auth, effective.auth]
    .filter(auth => auth?.kind === 'apiKey' && auth.key)
    .map(auth => auth!.key!.trim().toLowerCase()));
  const { method, path, bodyType, body, timeoutMs, form } = snapshot;
  const next = updateEnvironmentRequest(workspace, current.id, entry.environmentId,
    { method, path, query: restorePairs(snapshot.query, effective.query, apiKeys),
      headers: restorePairs(snapshot.headers, effective.headers, apiKeys),
      bodyType, body, timeoutMs, auth: effective.auth, form });
  return {
    ...next, activeProjectId: project.id,
    projects: next.projects.map(item => item.id === project.id ? { ...item, activeEnvironmentId: environment.id } : item),
  };
}
