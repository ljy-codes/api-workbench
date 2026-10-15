import type { AuthConfig, Environment, Pair, RequestDefinition, Variable, Workspace } from '../../types';
import { emptyWorkspace, newRequest, uid } from '../workspace';
import { exportProject } from '../exchange';

export type Obj = Record<string, unknown>;
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ENTITIES = 20000;
export const COLLECTIONS = ['projects', 'environments', 'services', 'bindings', 'folders', 'requests', 'variables'] as const;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export function check(value: unknown, message = '转换文件字段或引用无效'): asserts value {
  if (!value) throw new Error(message);
}
export function obj(value: unknown): Obj {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), '转换文件对象结构无效');
  return value as Obj;
}
export function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  check(Array.isArray(value) && value.length <= 10000, '转换文件列表类型无效或数量超过上限');
  return value;
}
export function str(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  check(typeof value === 'string' && value.length <= 2 * 1024 * 1024, '转换文件字符串字段类型或长度无效');
  return value;
}
export function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  check(typeof value === 'boolean', '转换文件布尔字段无效');
  return value;
}
export function ref(value: unknown): string {
  const id = str(value);
  check(id.trim() && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id), '转换文件 ID 字段无效');
  return id;
}
export function textLimit(text: string) {
  check(typeof text === 'string' && text.length <= MAX_BYTES && new TextEncoder().encode(text).byteLength <= MAX_BYTES, '转换文件大小超过 10 MiB 上限');
}
/** Also used on caller-owned objects: reject getters, cycles and non-JSON prototypes. */
export function safeTree(value: unknown) {
  let nodes = 0;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number) => {
    check(depth <= 32, '转换文件嵌套超过上限');
    check(++nodes <= 300000, '转换文件节点数量超过上限');
    if (typeof v === 'string') { str(v); return; }
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { check(Number.isFinite(v)); return; }
    check(typeof v === 'object' && v !== undefined, '转换文件含非 JSON 值');
    const o = v as object;
    check(!seen.has(o), '转换文件包含循环引用');
    seen.add(o);
    const proto = Object.getPrototypeOf(o);
    check(Array.isArray(o) || proto === Object.prototype || proto === null, '转换文件对象原型无效');
    if (Array.isArray(o)) check(o.length <= 10000, '转换文件列表数量超过上限');
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(o))) {
      check(!BAD_KEYS.has(key) && Object.hasOwn(d, 'value'), '转换文件含不安全字段');
      if (Array.isArray(o) && key === 'length') continue;
      walk(d.value, depth + 1);
    }
    seen.delete(o);
  };
  walk(value, 0);
}
export function exact(o: Obj, keys: string[]) {
  check(Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k)), '转换文件含未知字段或缺少字段');
}
export const pair = (key: string, value: string, enabled = true): Pair => ({ id: uid(), key, value, enabled });
export const REVIEW_WARNING = '已脱敏已知凭据并禁用本地文件；普通正文、路径及名称可能含业务敏感数据，请人工检查。';

/** No interpolation evaluation. Unsupported expressions become an empty, editable placeholder. */
export function yaakTemplate(value: string, warnings: Set<string>): string {
  return value.replace(/(\\*)\$\{\[([\s\S]*?)\]\}/g, (whole, slashes: string, expression: string) => {
    if (slashes.length % 2) return whole;
    const name = expression.trim();
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && !['true', 'false', 'null'].includes(name)) return `${slashes}{{${name}}}`;
    warnings.add('Yaak 动态模板/函数不受支持，已替换为待填写变量；不会执行函数、脚本或请求。');
    return `${slashes}{{transfer_unsupported_template}}`;
  });
}

export function mergePairs(...groups: Pair[][]): Pair[] {
  const merged = new Map<string, Pair[]>();
  for (const group of groups) {
    const local = new Map<string, Pair[]>();
    for (const p of group) {
      const key = p.key.toLowerCase();
      local.set(key, [...(local.get(key) ?? []), p]);
    }
    for (const [key, values] of local) merged.set(key, values);
  }
  return [...merged.values()].flat().map(p => ({ ...p, id: uid() }));
}

export interface ExternalEnvironment { environment: Environment; variables: Map<string, string> }
export class Builder {
  readonly workspace = emptyWorkspace();
  readonly warnings = new Set<string>([REVIEW_WARNING]);
  private services = new Map<string, string>();
  private pendingBindings = new Map<string, { key: string; variables: Map<string, string> }>();
  private entityCount = 0;

  reserve(count = 1) {
    this.entityCount += count;
    check(this.entityCount <= MAX_ENTITIES, '转换过程中总实体数量超过上限');
  }
  addRequest(request: RequestDefinition) {
    this.reserve(request.query.length + request.headers.length + (request.form?.length ?? 0));
    this.workspace.requests.push(request);
  }
  project(name: string): string {
    this.reserve();
    const id = uid();
    this.workspace.projects.push({ id, name, activeEnvironmentId: null });
    this.workspace.activeProjectId ??= id;
    return id;
  }
  environment(projectId: string, name: string, vars: Map<string, { value: string; secret: boolean }>): ExternalEnvironment {
    this.reserve();
    const environment: Environment = { id: uid(), projectId, name, isProduction: false };
    this.workspace.environments.push(environment);
    const project = this.workspace.projects.find(p => p.id === projectId)!;
    project.activeEnvironmentId ??= environment.id;
    const variables = new Map<string, string>();
    for (const [name, v] of vars) {
      variables.set(name, v.secret ? '' : v.value);
      this.variable(projectId, 'environment', environment.id, name, v.value, v.secret);
    }
    return { environment, variables };
  }
  variable(projectId: string, scope: Variable['scope'], ownerId: string, name: string, value: string, secret = false) {
    this.reserve();
    this.workspace.variables.push({ id: uid(), projectId, scope, ownerId, name, value, isSecret: secret });
  }
  service(projectId: string, key: string, environments: ExternalEnvironment[], scopeKey = ''): string {
    const cacheKey = JSON.stringify([projectId, key, scopeKey]);
    const found = this.services.get(cacheKey);
    if (found) return found;
    this.reserve();
    const id = uid();
    this.services.set(cacheKey, id);
    this.workspace.services.push({ id, projectId, name: key || 'HTTP 服务' });
    for (const env of environments) {
      this.reserve();
      const bindingId = uid();
      this.pendingBindings.set(bindingId, { key, variables: env.variables });
      this.workspace.bindings.push({ id: bindingId, projectId, serviceId: id, environmentId: env.environment.id, baseUrl: '', enabled: true });
    }
    return id;
  }
  finish(): Workspace {
    const clean = emptyWorkspace();
    for (const p of this.workspace.projects) {
      const single = JSON.parse(exportProject(this.workspace, p.id)).project as Workspace;
      const secrets = new Set(single.variables.filter(v => v.isSecret).map(v => v.name));
      for (const binding of single.bindings) {
        const pending = this.pendingBindings.get(binding.id)!;
        const safeVariables = new Map([...pending.variables].map(([name, value]) => [name, secrets.has(name) ? '' : value]));
        const resolved = this.resolveBase(pending.key, safeVariables);
        check(!/^https?:\/\/.*[@?#\\]/i.test(resolved), '服务域名变量包含凭据、Query、片段或反斜线，请清理后导入');
        let baseUrl = '';
        if (/^https?:\/\/[^/?#@\\\s{}]+(?:\/[^?#\\\s{}]*)?$/i.test(resolved)) {
          try {
            if (new URL(resolved).hostname) baseUrl = resolved;
          } catch { /* Retain an empty draft binding. */ }
        }
        if (!baseUrl) this.warnings.add('部分服务域名未解析或含不安全内容，已保留空绑定，请填写 HTTP(S) 基础地址。');
        binding.baseUrl = baseUrl;
      }
      for (const key of COLLECTIONS) (clean[key] as unknown[]).push(...single[key]);
    }
    clean.activeProjectId = clean.projects[0]?.id ?? null;
    return clean;
  }
  private resolveBase(value: string, variables: Map<string, string>): string {
    let current = value;
    for (let n = 0; n < 32; n++) {
      const next = current.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) => variables.get(name.trim()) ?? whole);
      check(next.length <= 2 * 1024 * 1024, '域名变量展开长度超过上限');
      if (next === current) return next;
      current = next;
    }
    return current;
  }
  request(projectId: string, name: string, url: string, environments: ExternalEnvironment[], scopeKey = ''): { request: RequestDefinition; rawQuery: Pair[] } | null {
    const hash = url.indexOf('#');
    if (hash >= 0) { this.warnings.add('URL 片段不参与 HTTP 请求，已移除。'); url = url.slice(0, hash); }
    const queryAt = url.indexOf('?');
    const rawQuery: Pair[] = [];
    if (queryAt >= 0) {
      for (const [key, value] of new URLSearchParams(url.slice(queryAt + 1))) rawQuery.push(pair(key, value));
      url = url.slice(0, queryAt);
    }
    const absolute = /^((?:https?|\{\{[^{}]+\}\}):\/\/[^/]+)(\/.*)?$/i.exec(url);
    const template = /^(\{\{[^{}]+\}\})(\/.*)?$/.exec(url);
    let base: string, path: string;
    if (absolute) {
      base = absolute[1]; path = absolute[2] ?? '/';
      check(!/[@\\\s]/.test(base), '请求 URL 不允许凭据、空白或反斜线');
    } else if (template) {
      base = template[1]; path = template[2] ?? '/';
    } else if (url.startsWith('/')) {
      base = ''; path = url;
    } else {
      this.warnings.add('已跳过非 HTTP(S) 或无法转换的 URL 协议请求；请在原工具处理。');
      return null;
    }
    const serviceId = this.service(projectId, base, environments, scopeKey);
    this.reserve();
    const request = newRequest(serviceId);
    request.name = name; request.path = path;
    return { request, rawQuery };
  }
}

export function genericAuth(type: string | null | undefined, data: Obj, warnings: Set<string>, convert: (s: string) => string): AuthConfig | undefined {
  if (type === undefined || type === null || type === 'inherit') return undefined;
  const read = (key: string) => convert(str(data[key], ''));
  if (type === 'none' || type === 'noauth') return { kind: 'none' };
  if (type === 'bearer') return { kind: 'bearer', token: read('token') };
  if (type === 'basic') return { kind: 'basic', username: read('username'), password: read('password') };
  if (type === 'apikey') {
    const location = data.location ?? data.in ?? 'header';
    check(location === 'header' || location === 'query', 'API Key 鉴权位置无效');
    return { kind: 'apiKey', key: read('key'), value: read('value'), location };
  }
  warnings.add('部分鉴权类型不受支持，已清除鉴权内容并设为无鉴权，请手动配置。');
  return { kind: 'none' };
}
