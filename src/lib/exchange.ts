import type { AuthConfig, Pair, VariableScope, Workspace } from '../types';
import { uid } from './workspace';

// Exchange is a draft-only boundary, not a database write or a credential backup.
// Limits apply before JSON.parse and again to the sanitized result.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_STRING = 2 * 1024 * 1024;
const MAX_ENTITIES = 20000;
const MAX_ARRAY = 10000;
const MAX_DEPTH = 32;
const COLLECTIONS = ['projects', 'environments', 'services', 'bindings', 'folders', 'requests', 'variables'] as const;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// A single bounded character class avoids overlapping whitespace quantifiers
// (untrusted, long incomplete references must not cause regex backtracking).
const REF = /^\{\{([^{}\u0000-\u001f\u007f]+)\}\}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), '项目文件对象结构无效');
  const o = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  check(Object.keys(o).every(k => !DANGEROUS_KEYS.has(k) && allowed.has(k)), '项目文件含未知或不安全字段');
  check(required.every(k => Object.hasOwn(o, k)), '项目文件缺少必要字段');
  return o;
}

function string(value: unknown, nonempty = false, limit = MAX_STRING): asserts value is string {
  check(typeof value === 'string' && value.length <= limit && (!nonempty || value.trim().length > 0), '项目文件字符串字段类型或长度无效');
}

function id(value: unknown): asserts value is string {
  string(value, true, 256);
  check(!/[\u0000-\u001f\u007f]/.test(value), '项目文件 ID 字段无效');
}

function nullableId(value: unknown) {
  if (value !== null) id(value);
}

function bool(value: unknown) {
  check(typeof value === 'boolean', '项目文件布尔字段类型无效');
}

function array(value: unknown): unknown[] {
  check(Array.isArray(value), '项目文件列表字段类型无效');
  check(value.length <= MAX_ARRAY, '项目文件列表数量超过上限');
  return value;
}

function auth(value: unknown) {
  if (value === null || value === undefined) return;
  const a = object(value, ['kind'], ['token', 'username', 'password', 'key', 'value', 'location']);
  check(['none', 'bearer', 'basic', 'apiKey'].includes(a.kind as string), '项目鉴权类型无效');
  for (const key of ['token', 'username', 'password', 'key', 'value']) {
    if (Object.hasOwn(a, key)) string(a[key]);
  }
  // Rust's defaulted DTO serializes unused location as ""; canonical TS omits it.
  if (a.location === '' && a.kind !== 'apiKey') delete a.location;
  if (Object.hasOwn(a, 'location')) check(a.location === 'header' || a.location === 'query', '项目鉴权位置字段无效');
  if (a.kind === 'apiKey') {
    string(a.key, true, 1024);
    check(a.location === 'header' || a.location === 'query', '项目 API Key 鉴权位置无效');
    if (a.location === 'header') check(TOKEN.test(a.key), '项目鉴权 Header 字段无效');
  }
}

function entities(w: Workspace): { id: string }[] {
  return [
    ...COLLECTIONS.flatMap<{ id: string }>(key => w[key]),
    ...w.services.flatMap(s => s.headers ?? []),
    ...w.requests.flatMap(r => [...r.query, ...r.headers, ...(r.form ?? [])]),
  ];
}

function validate(value: unknown): asserts value is Workspace {
  const o = object(value, ['revision', 'activeProjectId', ...COLLECTIONS]);
  check(Number.isSafeInteger(o.revision) && (o.revision as number) >= 0, '项目 revision 字段无效');
  nullableId(o.activeProjectId);
  for (const key of COLLECTIONS) array(o[key]);
  check((o.projects as unknown[]).length === 1, '交换文件必须恰好包含一个项目');
  let count = 0;
  const seen = new Set<string>();
  const entity = (v: unknown, fields: string[], optional: string[] = []) => {
    const e = object(v, ['id', ...fields], optional);
    id(e.id);
    check(!seen.has(e.id), '项目文件包含重复 ID');
    seen.add(e.id);
    check(++count <= MAX_ENTITIES, '项目实体数量超过上限');
    return e;
  };
  const pairs = (v: unknown, form = false) => {
    for (const item of array(v)) {
      const p = entity(item, ['key', 'value', 'enabled', ...(form ? ['kind'] : [])]);
      string(p.key); string(p.value); bool(p.enabled);
      if (form) check(p.kind === 'text' || p.kind === 'file', '项目表单类型字段无效');
    }
  };
  for (const item of o.projects as unknown[]) {
    const p = entity(item, ['name', 'activeEnvironmentId']);
    string(p.name, true, 1024); nullableId(p.activeEnvironmentId);
  }
  for (const item of o.environments as unknown[]) {
    const e = entity(item, ['projectId', 'name', 'isProduction']);
    id(e.projectId); string(e.name, true, 1024); bool(e.isProduction);
  }
  for (const item of o.services as unknown[]) {
    const s = entity(item, ['projectId', 'name'], ['headers', 'auth']);
    id(s.projectId); string(s.name, true, 1024);
    if (Object.hasOwn(s, 'headers')) pairs(s.headers);
    auth(s.auth);
  }
  for (const item of o.bindings as unknown[]) {
    const b = entity(item, ['projectId', 'serviceId', 'environmentId', 'baseUrl', 'enabled']);
    id(b.projectId); id(b.serviceId); id(b.environmentId); string(b.baseUrl); bool(b.enabled);
    // Draft empty bindings are valid. Nonempty bindings may not smuggle URL credentials.
    if (b.baseUrl) {
      check(/^https?:\/\/[^/?#@\\\s{}]+(?:\/[^?#\\\s{}]*)?$/i.test(b.baseUrl), '项目基础地址无效：不允许凭据、Query 或片段');
      try { check(Boolean(new URL(b.baseUrl).hostname), '项目基础地址无效'); }
      catch { throw new Error('项目基础地址无效'); }
    }
  }
  for (const item of o.folders as unknown[]) {
    const f = entity(item, ['serviceId', 'parentId', 'name']);
    id(f.serviceId); nullableId(f.parentId); string(f.name, true, 1024);
  }
  for (const item of o.requests as unknown[]) {
    const r = entity(item, ['serviceId', 'folderId', 'name', 'method', 'path', 'query', 'headers', 'bodyType', 'body', 'timeoutMs'], ['auth', 'form']);
    id(r.serviceId); nullableId(r.folderId); string(r.name, true, 1024);
    string(r.method, true, 64); check(TOKEN.test(r.method), '项目请求方法字段无效');
    string(r.path); string(r.body);
    check(!/[?#\u0000-\u001f\u007f]/.test(r.path), '项目路径字段不能包含 Query、片段或控制字符，请使用 Query 列表');
    check(['none', 'json', 'text', 'form', 'multipart'].includes(r.bodyType as string), '项目请求正文类型无效');
    check(Number.isSafeInteger(r.timeoutMs) && (r.timeoutMs as number) >= 1 && (r.timeoutMs as number) <= 300000, '项目请求超时字段无效');
    pairs(r.query); pairs(r.headers); auth(r.auth);
    if (Object.hasOwn(r, 'form')) pairs(r.form, true);
  }
  for (const item of o.variables as unknown[]) {
    const v = entity(item, ['projectId', 'scope', 'ownerId', 'name', 'value', 'isSecret']);
    id(v.projectId); id(v.ownerId); string(v.name, true, 256); string(v.value); bool(v.isSecret);
    check(v.name.trim() === v.name && !/[{}\u0000-\u001f\u007f]/.test(v.name), '项目变量名称字段无效');
    check(['project', 'service', 'environment', 'binding', 'request'].includes(v.scope as string), '项目变量 scope 类型无效');
  }
  // Only after every field was checked may we use typed entity references.
  references(value as Workspace);
}

function references(w: Workspace) {
  const projectId = w.projects[0].id;
  const envs = new Map(w.environments.map(e => [e.id, e]));
  const services = new Map(w.services.map(s => [s.id, s]));
  const folders = new Map(w.folders.map(f => [f.id, f]));
  const owners: Record<VariableScope, Set<string>> = {
    project: new Set([projectId]), environment: new Set(envs.keys()), service: new Set(services.keys()),
    binding: new Set(w.bindings.map(b => b.id)), request: new Set(w.requests.map(r => r.id)),
  };
  for (const e of [...w.environments, ...w.services, ...w.bindings, ...w.variables]) {
    check(e.projectId === projectId, '项目文件包含跨项目引用');
  }
  const bindings = new Set<string>();
  for (const b of w.bindings) {
    check(services.has(b.serviceId) && envs.has(b.environmentId), '项目绑定引用不存在');
    const key = JSON.stringify([b.serviceId, b.environmentId]);
    check(!bindings.has(key), '项目包含重复服务环境绑定');
    bindings.add(key);
  }
  for (const f of w.folders) {
    check(services.has(f.serviceId), '项目目录服务引用不存在');
    const chain = new Set<string>([f.id]);
    let parentId = f.parentId;
    while (parentId !== null) {
      const parent = folders.get(parentId);
      check(parent && parent.serviceId === f.serviceId, '项目目录父级引用无效');
      check(!chain.has(parentId), '项目目录引用存在环');
      chain.add(parentId);
      check(chain.size <= MAX_DEPTH, '项目目录嵌套超过上限');
      parentId = parent.parentId;
    }
  }
  for (const r of w.requests) {
    check(services.has(r.serviceId), '项目请求服务引用不存在');
    check(r.folderId === null || folders.get(r.folderId)?.serviceId === r.serviceId, '项目请求目录引用无效');
  }
  const variables = new Set<string>();
  for (const v of w.variables) {
    check(owners[v.scope].has(v.ownerId), '项目变量 owner 引用不存在');
    const key = JSON.stringify([v.scope, v.ownerId, v.name]);
    check(!variables.has(key), '项目包含同作用域重复变量');
    variables.add(key);
  }
}

function boundedText(text: string) {
  check(typeof text === 'string' && text.length <= MAX_BYTES, '项目文件大小超过 10 MiB 上限');
  check(new TextEncoder().encode(text).byteLength <= MAX_BYTES, '项目文件大小超过 10 MiB 上限');
}

function parse(text: string): Workspace {
  boundedText(text);
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') check(++depth <= MAX_DEPTH, '项目文件嵌套超过上限');
    else if (c === '}' || c === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('项目文件不是有效的 JSON'); }
  const root = object(value, ['format', 'version', 'project']);
  check(root.format === 'api-workbench' && root.version === 1, '不支持的项目交换格式或版本');
  validate(root.project);
  return root.project;
}

function allocator(w: Workspace, extra: string[] = []) {
  const used = new Set([...entities(w).map(e => e.id), ...extra]);
  return () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = uid();
      if (!used.has(value)) { used.add(value); return value; }
    }
    throw new Error('无法分配新的项目实体 ID，请重试');
  };
}

function sensitive(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|cookie|token|apikey|secret|password|passwd|credential|sessionid|signature)$/.test(normalized)
    || ['key', 'auth', 'session', 'sid', 'pwd', 'xcsrf', 'xcsrftoken', 'xsrftoken'].includes(normalized);
}

function scrub(w: Workspace, allocate = allocator(w)) {
  const usedNames = new Set(w.variables.map(v => v.name));
  const sensitiveNames = new Set<string>();
  let sequence = 0;
  const protect = (value: string, scope: 'service' | 'request', ownerId: string, header = false): string => {
    if (!value) return '';
    for (const match of value.matchAll(/\{\{([^{}\u0000-\u001f\u007f]+)\}\}/g)) {
      sensitiveNames.add(match[1].trim());
    }
    const reference = REF.exec(value) ?? (header ? /^(?:Bearer|Basic)\s+(\{\{[^{}\u0000-\u001f\u007f]+\}\})$/i.exec(value) : null);
    const referenceName = reference && (REF.exec(reference[1])?.[1] ?? reference[1]).trim();
    if (referenceName) {
      const name = referenceName;
      sensitiveNames.add(name);
      return value;
    }
    let name: string;
    do { name = `exchange_secret_${++sequence}`; } while (usedNames.has(name));
    usedNames.add(name);
    w.variables.push({ id: allocate(), projectId: w.projects[0].id, scope, ownerId, name, value: '', isSecret: true });
    return `{{${name}}}`;
  };
  const cleanAuth = (a: AuthConfig | null | undefined, scope: 'service' | 'request', owner: string) => {
    if (!a) return;
    // Scrub unused fields too: disabled auth is not an excuse to export old secrets.
    for (const field of ['token', 'username', 'password', 'value'] as const) {
      if (a[field] !== undefined) a[field] = protect(a[field], scope, owner);
    }
  };
  const cleanPairs = (pairs: Pair[], scope: 'service' | 'request', owner: string, header: boolean) => {
    for (const p of pairs) if (sensitive(p.key)) p.value = protect(p.value, scope, owner, header && /authorization$/i.test(p.key));
  };
  for (const s of w.services) {
    cleanPairs(s.headers ?? [], 'service', s.id, true);
    cleanAuth(s.auth, 'service', s.id);
  }
  for (const r of w.requests) {
    cleanPairs(r.headers, 'request', r.id, true);
    cleanPairs(r.query, 'request', r.id, false);
    cleanAuth(r.auth, 'request', r.id);
    for (const field of r.form ?? []) {
      if (field.kind === 'file') { field.value = ''; field.enabled = false; }
      else if (sensitive(field.key)) field.value = protect(field.value, 'request', r.id);
    }
  }
  for (const v of w.variables) {
    if (v.isSecret || sensitiveNames.has(v.name) || sensitive(v.name)) { v.isSecret = true; v.value = ''; }
  }
}

function selectActive(w: Workspace) {
  const p = w.projects[0];
  w.activeProjectId = p.id;
  if (!w.environments.some(e => e.id === p.activeEnvironmentId)) p.activeEnvironmentId = w.environments[0]?.id ?? null;
}

/**
 * 导出单项目脱敏交换文件，不修改工作区，不包含可恢复的凭据。
 *
 * UI 必须在导出前提示：“普通正文、路径、名称及自定义字段也可能含秘密，
 * 自动脱敏不能识别所有业务数据，请人工检查后再分享。”
 * 本模块只处理已知凭据字段，不宣称任意正文已安全；不读文件、不保存数据库。
 */
export function exportProject(workspace: Workspace, projectId: string): string {
  const project = workspace.projects.find(p => p.id === projectId);
  check(project, '找不到要导出的项目');
  const services = workspace.services.filter(s => s.projectId === projectId);
  const serviceIds = new Set(services.map(s => s.id));
  const selected = structuredClone({
    revision: workspace.revision, activeProjectId: projectId, projects: [project],
    environments: workspace.environments.filter(e => e.projectId === projectId),
    services, bindings: workspace.bindings.filter(b => b.projectId === projectId),
    folders: workspace.folders.filter(f => serviceIds.has(f.serviceId)),
    requests: workspace.requests.filter(r => serviceIds.has(r.serviceId)),
    variables: workspace.variables.filter(v => v.projectId === projectId),
  });
  validate(selected);
  scrub(selected);
  selectActive(selected);
  validate(selected);
  const text = JSON.stringify({ format: 'api-workbench', version: 1, project: selected }, null, 2);
  boundedText(text);
  return text;
}

/**
 * 严格导入单项目为新草稿。上限：UTF-8 10 MiB、单字段 2 Mi 字符、
 * 单列表 10,000、总实体（含 Pair/Form）20,000、JSON/目录深度 32。
 * 重新分配所有 ID，保留目标 revision 与无关数据；不自动保存或发起请求。
 * 交换文件的凭据一律清空，文件字段须重新选择；正文仍需人工检查。
 */
export function importProject(workspace: Workspace, text: string): Workspace {
  const imported = parse(text);
  const allocate = allocator(workspace, entities(imported).map(e => e.id));
  scrub(imported, allocate);
  validate(imported);
  selectActive(imported);
  const remap = new Map(entities(imported).map(e => [e.id, allocate()]));
  const mapped = (value: string) => {
    const result = remap.get(value);
    check(result, '项目实体引用无法重映射');
    return result;
  };
  for (const e of entities(imported)) e.id = mapped(e.id);
  imported.activeProjectId = mapped(imported.activeProjectId!);
  for (const p of imported.projects) if (p.activeEnvironmentId !== null) p.activeEnvironmentId = mapped(p.activeEnvironmentId);
  for (const e of [...imported.environments, ...imported.services, ...imported.bindings, ...imported.variables]) e.projectId = mapped(e.projectId);
  for (const e of [...imported.bindings, ...imported.folders, ...imported.requests]) e.serviceId = mapped(e.serviceId);
  for (const b of imported.bindings) b.environmentId = mapped(b.environmentId);
  for (const f of imported.folders) if (f.parentId !== null) f.parentId = mapped(f.parentId);
  for (const r of imported.requests) if (r.folderId !== null) r.folderId = mapped(r.folderId);
  for (const v of imported.variables) v.ownerId = mapped(v.ownerId);
  const names = new Set(workspace.projects.map(p => p.name));
  const p = imported.projects[0];
  const base = p.name;
  for (let suffix = 2; names.has(p.name); suffix++) {
    const ending = ` (${suffix})`;
    p.name = base.slice(0, 1024 - ending.length).replace(/[\uD800-\uDBFF]$/, '') + ending;
  }
  validate(imported);
  boundedText(JSON.stringify({ format: 'api-workbench', version: 1, project: imported }));
  return {
    ...workspace, activeProjectId: p.id,
    projects: [...workspace.projects, ...imported.projects],
    environments: [...workspace.environments, ...imported.environments],
    services: [...workspace.services, ...imported.services],
    bindings: [...workspace.bindings, ...imported.bindings],
    folders: [...workspace.folders, ...imported.folders],
    requests: [...workspace.requests, ...imported.requests],
    variables: [...workspace.variables, ...imported.variables],
  };
}
