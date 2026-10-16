import type { RequestConfig, Variable, Workspace } from '../types';

// Only compare complete HTTP(S) addresses. Bare hosts are legacy HTTP values;
// never infer HTTPS or treat a business word as a host.
function addressKey(value: string, allowBare = false): string | null {
  if (!value || /[\s\u0000-\u001f\u007f-\u009f\\?#{}]/.test(value)) return null;
  let candidate = value;
  if (allowBare && !value.includes('://')) {
    const host = value.split('/')[0];
    if (!host.includes('.') && !/^localhost(?::\d+)?$/i.test(host) && !host.startsWith('[')) return null;
    candidate = `http://${value}`;
  }
  if (!/^https?:\/\//i.test(candidate)) return null;
  // Match the native base-address rules before URL can normalize invalid
  // authority or traversal into the same value as a valid binding.
  const rest = candidate.slice(candidate.indexOf('://') + 3);
  const separator = rest.indexOf('/');
  const authority = separator < 0 ? rest : rest.slice(0, separator);
  const path = separator < 0 ? '' : rest.slice(separator);
  if (!authority || authority.includes('@') || /%(?![0-9a-f]{2})/i.test(path)) return null;
  for (const segment of path.split('/')) {
    const decoded = segment.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === '.' || decoded === '..' || decoded.includes('\\')) return null;
  }
  try {
    const url = new URL(candidate);
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function findServiceAddressVariables(workspace: Workspace): Variable[] {
  const serviceProjects = new Map(workspace.services.map(s => [s.id, s.projectId]));
  const environmentProjects = new Map(workspace.environments.map(e => [e.id, e.projectId]));
  const addresses = new Set<string>();
  for (const binding of workspace.bindings) {
    if (serviceProjects.get(binding.serviceId) !== binding.projectId || environmentProjects.get(binding.environmentId) !== binding.projectId) continue;
    const address = addressKey(binding.baseUrl);
    if (address) addresses.add(JSON.stringify([binding.projectId, binding.environmentId, address]));
  }
  return workspace.variables.filter(v => {
    if (v.scope !== 'environment' || v.isSecret || !v.name.trim()) return false;
    const address = addressKey(v.value, true);
    return address !== null && addresses.has(JSON.stringify([v.projectId, v.ownerId, address]));
  });
}

function collectReferences(value: unknown, names: Set<string>) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) names.add(match[1].trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, names);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectReferences(item, names);
  }
}

function collectConfig(config: RequestConfig, names: Set<string>) {
  collectReferences([config.query, config.headers, config.auth, config.body, config.form], names);
  if (config.bodyType === 'json') {
    // The native engine parses JSON before rendering string values. Escaped
    // braces may therefore introduce a reference absent from the raw text.
    try { collectReferences(JSON.parse(config.body), names); }
    catch { /* Keep incomplete JSON drafts intact; raw text was checked above. */ }
  }
}

export function unifyServiceAddresses(workspace: Workspace): Workspace {
  const candidates = findServiceAddressVariables(workspace);
  if (!candidates.length) return workspace;
  const references = new Map(candidates.map(v => [v.projectId, new Set<string>()]));
  const serviceProjects = new Map(workspace.services.map(s => [s.id, s.projectId]));
  for (const service of workspace.services) {
    const names = references.get(service.projectId);
    if (names) collectReferences([service.headers, service.auth], names);
  }
  for (const request of workspace.requests) {
    const names = references.get(serviceProjects.get(request.serviceId) ?? '');
    if (!names) continue;
    collectReferences(request.path, names);
    collectConfig(request, names);
    for (const config of Object.values(request.environmentConfigs ?? {})) collectConfig(config, names);
  }
  const nameCounts = new Map<string, number>();
  for (const variable of workspace.variables) {
    const key = JSON.stringify([variable.projectId, variable.scope, variable.ownerId, variable.name]);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    const names = references.get(variable.projectId);
    if (names) collectReferences(variable.value, names);
  }
  const removed = new Set(candidates.filter(v =>
    !references.get(v.projectId)!.has(v.name)
    && nameCounts.get(JSON.stringify([v.projectId, v.scope, v.ownerId, v.name])) === 1,
  ).map(v => v.id));
  return removed.size ? { ...workspace, variables: workspace.variables.filter(v => !removed.has(v.id)) } : workspace;
}
