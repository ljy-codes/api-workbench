import type { AuthConfig, Pair, RequestDefinition } from '../../types';
import { uid } from '../workspace';
import { Builder, check, flag, genericAuth, list, obj, pair, ref, str, type Obj } from './shared';

// postmanlabs/postman-runtime: lib/requester/core-body-builder.js.
const RAW_CONTENT_TYPES = new Map([
  ['html', 'text/html'], ['text', 'text/plain'], ['json', 'application/json'],
  ['javascript', 'application/javascript'], ['xml', 'application/xml'],
]);

function variables(value: unknown, builder: Builder) {
  const result = new Map<string, { value: string; secret: boolean }>();
  for (const item of list(value)) {
    const v = obj(item), name = str(v.key ?? v.id);
    check(!result.has(name), 'Postman 同作用域变量重复');
    const enabled = flag(v.enabled, true) && !flag(v.disabled, false);
    if (!enabled) { builder.warnings.add('Postman 禁用变量已忽略，导入后不参与变量解析。'); continue; }
    const raw = v.value === undefined ? '' : v.value;
    check(typeof raw === 'string' || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw)), 'Postman 变量值类型无效');
    result.set(name, { value: String(raw), secret: v.type === 'secret' });
  }
  return result;
}

function auth(value: unknown, builder: Builder): AuthConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const a = obj(value), type = str(a.type);
  const data: Obj = Object.create(null) as Obj;
  const raw = a[type];
  if (Array.isArray(raw)) {
    for (const item of list(raw)) {
      const entry = obj(item), key = str(entry.key);
      check(!['__proto__', 'prototype', 'constructor'].includes(key) && !Object.hasOwn(data, key), 'Postman 鉴权属性无效');
      data[key] = entry.value;
    }
  } else if (raw !== undefined) Object.assign(data, obj(raw));
  return genericAuth(type, data, builder.warnings, value => value);
}

function pairs(value: unknown): Pair[] {
  if (typeof value === 'string') {
    return value.split(/\r?\n/).filter(s => s.trim()).map(line => {
      const colon = line.indexOf(':');
      check(colon > 0, 'Postman Header 文本结构无效');
      return pair(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    });
  }
  return list(value).map(item => {
    const p = obj(item);
    return pair(str(p.key), str(p.value, ''), !flag(p.disabled, false));
  });
}

function body(r: RequestDefinition, value: unknown, b: Builder) {
  if (value === undefined || value === null) return;
  const raw = obj(value);
  if (flag(raw.disabled, false)) { b.warnings.add('Postman 禁用正文已忽略。'); return; }
  const mode = str(raw.mode, '');
  if (mode === 'raw') {
    r.body = str(raw.raw, '');
    const options = raw.options === undefined ? {} : obj(raw.options);
    const rawOptions = options.raw === undefined ? {} : obj(options.raw);
    const language = str(rawOptions.language, 'text');
    r.bodyType = language === 'json' || r.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type' && /json/i.test(h.value)) ? 'json' : 'text';
    if (!r.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type')) {
      r.headers.push(pair('Content-Type', RAW_CONTENT_TYPES.get(language) ?? 'text/plain'));
    }
  } else if (mode === 'urlencoded' || mode === 'formdata') {
    r.bodyType = mode === 'urlencoded' ? 'form' : 'multipart';
    r.form = list(raw[mode]).map(item => {
      const p = obj(item), file = p.type === 'file';
      if (file) b.warnings.add('本地文件上传字段已清空并禁用，请重新选择文件。');
      return { id: uid(), key: str(p.key), value: file ? '' : str(p.value, ''), enabled: file ? false : !flag(p.disabled, false), kind: file ? 'file' : 'text' };
    });
  } else if (mode === 'graphql') {
    const data = obj(raw.graphql);
    const query = str(data.query, ''), vars = str(data.variables, '');
    let parsed: unknown = {};
    if (vars) { try { parsed = JSON.parse(vars); } catch { throw new Error('Postman GraphQL 变量不是有效 JSON'); } }
    r.bodyType = 'json'; r.body = JSON.stringify({ query, variables: parsed });
  } else if (mode === 'file') {
    b.warnings.add('Postman 二进制文件正文不受支持，已清空，请重新选择文件。');
  } else if (mode) b.warnings.add('部分 Postman 正文模式不受支持，已清空正文，请手动配置。');
}

function urlParts(value: unknown): { url: string; query?: Pair[]; pathVariables: Map<string, string> } {
  if (typeof value === 'string') return { url: value, pathVariables: new Map() };
  const u = obj(value);
  let url: string;
  if (u.raw !== undefined) url = str(u.raw);
  else {
    const host = typeof u.host === 'string' ? u.host : list(u.host).map(v => str(v)).join('.');
    const path = typeof u.path === 'string' ? u.path : list(u.path).map(v => str(v)).join('/');
    const protocol = str(u.protocol, 'https');
    const port = u.port === undefined ? '' : `:${str(u.port)}`;
    url = `${protocol}://${host}${port}/${path.replace(/^\//, '')}`;
  }
  const pathVariables = new Map<string, string>();
  for (const item of list(u.variable)) {
    const v = obj(item), key = str(v.key);
    check(!pathVariables.has(key), 'Postman 路径变量重复');
    if (!flag(v.disabled, false)) pathVariables.set(key, str(v.value, ''));
  }
  return { url, ...(u.query !== undefined ? { query: pairs(u.query) } : {}), pathVariables };
}

export function fromPostman(root: Obj): Builder {
  const b = new Builder(), sourceIds = new Set<string>();
  const id = (o: Obj) => {
    if (o.id === undefined && o._postman_id === undefined) return;
    const value = ref(o.id ?? o._postman_id);
    check(!sourceIds.has(value), 'Postman 包含重复 ID');
    sourceIds.add(value);
  };
  if (root._postman_variable_scope === 'environment') {
    id(root);
    const projectId = b.project(str(root.name, 'Postman 环境'));
    b.environment(projectId, str(root.name, '默认环境'), variables(root.values, b));
    return b;
  }
  const info = obj(root.info);
  check(typeof info.schema === 'string' && /^https?:\/\/schema\.getpostman\.com\/json\/collection\/v2\.(?:0|1)\.0\/collection\.json$/.test(info.schema), '不支持的 Postman collection 版本');
  id(info);
  const projectId = b.project(str(info.name));
  const rootVars = variables(root.variable, b);
  const env = b.environment(projectId, '默认环境', rootVars);
  const environments = [env];
  const events = (o: Obj) => {
    if (list(o.event).length) b.warnings.add('Postman 前置/测试脚本不受支持，已忽略；不会执行脚本。');
    if (o.response !== undefined && list(o.response).length) b.warnings.add('Postman 示例响应不导入。');
    if (o.protocolProfileBehavior !== undefined) b.warnings.add('Postman 协议选项不导入，请检查重定向、Cookie 和 TLS 设置。');
  };
  const rootAuth = auth(root.auth, b);
  events(root);
  // Folder trees must be instantiated independently for every host service.
  const folderCache = new Map<string, string>();
  interface FolderNode { key: string; name: string; vars: ReturnType<typeof variables> }
  const folderChains: FolderNode[][] = [];
  const folderFor = (serviceId: string, chain: FolderNode[]) => {
    let parentId: string | null = null;
    for (const f of chain) {
      const key = JSON.stringify([serviceId, f.key]);
      let current = folderCache.get(key);
      if (!current) {
        b.reserve();
        current = uid(); folderCache.set(key, current);
        b.workspace.folders.push({ id: current, serviceId, parentId, name: f.name });
      }
      parentId = current;
    }
    return parentId;
  };
  const walk = (items: unknown, chain: FolderNode[], inheritedAuth: AuthConfig | undefined) => {
    check(chain.length <= 24, 'Postman 目录嵌套超过上限');
    for (const item of list(items)) {
      const entry = obj(item);
      id(entry); events(entry);
      const ownAuth = auth(entry.auth, b) ?? inheritedAuth;
      if (entry.item !== undefined) {
        check(entry.request === undefined, 'Postman 节点不能同时是目录和请求');
        const childChain = [...chain, { key: uid(), name: str(entry.name, '目录'), vars: variables(entry.variable, b) }];
        folderChains.push(childChain);
        walk(entry.item, childChain, ownAuth);
        continue;
      }
      check(entry.request !== undefined, 'Postman 节点缺少请求或子目录');
      const req = typeof entry.request === 'string' ? { url: entry.request, method: 'GET' } : obj(entry.request);
      const parts = urlParts(req.url);
      const vars = new Map(rootVars);
      for (const f of chain) for (const [name, v] of f.vars) vars.set(name, v);
      for (const [name, v] of variables(entry.variable, b)) vars.set(name, v);
      // Hosts may use folder variables; resolve per request to avoid accidentally
      // sharing one binding between different folder overrides.
      const overrides = [...vars].filter(([name, v]) => rootVars.get(name) !== v);
      const effectiveEnvs = overrides.length ? [{
        environment: env.environment,
        variables: new Map([...env.variables, ...overrides.map(([name, v]) => [name, v.secret ? '' : v.value] as [string, string])]),
      }] : environments;
      const built = b.request(projectId, str(entry.name, '请求'), parts.url, effectiveEnvs, overrides.length ? JSON.stringify(overrides) : '');
      if (!built) continue;
      const { request: r, rawQuery } = built;
      r.folderId = folderFor(r.serviceId, chain);
      r.method = str(req.method, 'GET');
      r.query = parts.query ?? rawQuery;
      r.headers = pairs(req.header);
      r.path = r.path.replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, (whole, key: string) => {
        if (!parts.pathVariables.has(key)) return whole;
        return `{{${key}}}`;
      });
      for (const [name, v] of vars) if (rootVars.get(name) !== v) b.variable(projectId, 'request', r.id, name, v.value, v.secret);
      for (const [name, value] of parts.pathVariables) b.variable(projectId, 'request', r.id, name, value);
      const effectiveAuth = auth(req.auth, b) ?? ownAuth;
      if (effectiveAuth) r.auth = effectiveAuth;
      body(r, req.body, b);
      b.addRequest(r);
    }
  };
  walk(root.item, [], rootAuth);
  if (folderChains.length) {
    const services = b.workspace.services.length ? b.workspace.services.map(s => s.id) : [b.service(projectId, '', environments)];
    for (const sid of services) for (const chain of folderChains) folderFor(sid, chain);
  }
  if (!b.workspace.requests.length && list(root.item).length) b.warnings.add('该文件没有可转换的 HTTP 请求；仅保留项目及环境。');
  return b;
}
