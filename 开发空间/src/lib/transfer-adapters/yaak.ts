import type { AuthConfig, Pair, RequestDefinition } from '../../types';
import { uid } from '../workspace';
import { Builder, check, flag, genericAuth, list, mergePairs, obj, pair, ref, str, yaakTemplate, type Obj } from './shared';

// Official sources pinned to mountain-loop/yaak v2026.9.0:
// crates/yaak-models/src/util.rs: WorkspaceExport / BatchUpsertResult
// crates/yaak-models/bindings/gen_models.ts: fields, MIME body types, parentModel
// plugins/importer-yaak/src/index.ts: schema 1 -> 5 migrations
// crates/yaak-sync/src/models.rs: per-model JSON/YAML documents (model discriminator)
// crates/yaak-templates/src/parser.rs: ${[ variable ]} (never evaluated here)
const GROUPS = ['workspaces', 'environments', 'folders', 'httpRequests', 'grpcRequests', 'websocketRequests'] as const;
const MODEL_GROUP = new Map<string, typeof GROUPS[number]>([
  ['workspace', 'workspaces'], ['environment', 'environments'], ['folder', 'folders'],
  ['http_request', 'httpRequests'], ['grpc_request', 'grpcRequests'], ['websocket_request', 'websocketRequests'],
]);
type Vars = Map<string, { value: string; secret: boolean }>;
interface Scope { headers: Pair[]; auth?: AuthConfig; timeout: number }

export function fromYaak(value: unknown): Builder {
  const b = new Builder();
  const convert = (value: string) => yaakTemplate(value, b.warnings);
  const resources = new Map<typeof GROUPS[number], Obj[]>(GROUPS.map(k => [k, []]));
  let schema = 5;
  if (!Array.isArray(value) && obj(value).yaakSchema !== undefined) {
    const root = obj(value);
    check(Number.isSafeInteger(root.yaakSchema) && (root.yaakSchema as number) >= 1 && (root.yaakSchema as number) <= 5, '不支持的 Yaak 导出版本');
    schema = root.yaakSchema as number;
    const raw = obj(root.resources);
    check(Object.keys(raw).every(k => GROUPS.includes(k as typeof GROUPS[number]) || (schema === 1 && k === 'requests')), 'Yaak resources 包含未知资源类型');
    check(!(raw.requests !== undefined && raw.httpRequests !== undefined), 'Yaak 存在重复请求集合');
    for (const key of GROUPS) resources.set(key, list(key === 'httpRequests' && schema === 1 ? (raw.requests ?? raw.httpRequests) : raw[key]).map(obj));
  } else {
    for (const v of Array.isArray(value) ? value : [value]) {
      const model = obj(v), type = str(model.model);
      const group = MODEL_GROUP.get(type);
      check(group, '无法识别 Yaak 官方模型或工作区');
      if (model.type !== undefined) check(model.type === type, 'Yaak 同步模型类型不一致');
      resources.get(group)!.push(model);
    }
  }
  const all = [...resources.values()].flat(), ids = new Set<string>();
  for (const model of all) {
    const id = ref(model.id);
    check(!ids.has(id), 'Yaak 包含重复 ID'); ids.add(id);
  }
  check(all.length <= 20000, 'Yaak 总实体数量超过上限');
  const workspaces = resources.get('workspaces')!;
  check(workspaces.length > 0, 'Yaak 文件缺少工作区，被引用的工作区必须一同提供');
  const workspaceIds = new Set(workspaces.map(w => ref(w.id)));
  for (const key of GROUPS.filter(k => k !== 'workspaces')) {
    for (const m of resources.get(key)!) {
      check(workspaceIds.has(ref(m.workspaceId)), 'Yaak 工作区引用不存在');
      if (m.model !== undefined) check(MODEL_GROUP.get(str(m.model)) === key, 'Yaak 资源模型类型无效');
    }
  }
  if (resources.get('grpcRequests')!.length) b.warnings.add('Yaak gRPC 协议请求不受支持，已跳过；HTTP 请求仍保留。');
  if (resources.get('websocketRequests')!.length) b.warnings.add('Yaak WebSocket 协议请求不受支持，已跳过；HTTP 请求仍保留。');

  const vars = (value: unknown): Vars => {
    const map: Vars = new Map(), seenNames = new Set<string>(), rowIds = new Set<string>();
    for (const v of list(value)) {
      const raw = obj(v), name = str(raw.name);
      check(!seenNames.has(name), 'Yaak 同作用域变量重复'); seenNames.add(name);
      if (raw.id !== undefined) { const id = ref(raw.id); check(!rowIds.has(id), 'Yaak 变量行 ID 重复'); rowIds.add(id); }
      if (!flag(raw.enabled, true)) { b.warnings.add('Yaak 禁用变量已忽略，导入后不参与变量解析。'); continue; }
      map.set(name, { value: convert(str(raw.value, '')), secret: flag(raw.isSecret, false) });
    }
    return map;
  };
  const headers = (value: unknown): Pair[] => {
    const rowIds = new Set<string>();
    return list(value).map(v => {
      const raw = obj(v);
      if (raw.id !== undefined) { const id = ref(raw.id); check(!rowIds.has(id), 'Yaak Header 行 ID 重复'); rowIds.add(id); }
      return pair(str(raw.name), convert(str(raw.value, '')), flag(raw.enabled, true));
    });
  };
  const scope = (raw: Obj, parent: Scope): Scope => {
    const type = raw.authenticationType;
    check(type === undefined || type === null || typeof type === 'string', 'Yaak 鉴权类型无效');
    const auth = genericAuth(type as string | null | undefined, raw.authentication === undefined ? {} : obj(raw.authentication), b.warnings, convert) ?? parent.auth;
    let timeout = parent.timeout;
    if (raw.settingRequestTimeout !== undefined) {
      if (typeof raw.settingRequestTimeout === 'number') timeout = raw.settingRequestTimeout;
      else {
        const setting = obj(raw.settingRequestTimeout);
        if (flag(setting.enabled, false)) {
          check(typeof setting.value === 'number', 'Yaak 请求超时字段无效');
          timeout = setting.value;
        }
      }
    }
    if (timeout === 0) { timeout = 300000; b.warnings.add('Yaak 无超时限制已转换为 EnvDock 最大超时 300 秒。'); }
    check(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300000, 'Yaak 请求超时超过支持范围');
    return { headers: mergePairs(parent.headers, headers(raw.headers)), ...(auth ? { auth } : {}), timeout };
  };
  for (const rawWorkspace of workspaces) {
    const wid = ref(rawWorkspace.id), projectId = b.project(str(rawWorkspace.name, 'Yaak 工作区'));
    const local = (group: typeof GROUPS[number]) => resources.get(group)!.filter(m => m.workspaceId === wid);
    const folders = local('folders'), environments = local('environments'), requests = local('httpRequests');
    const folderMap = new Map(folders.map(f => [ref(f.id), f]));
    const environmentMap = new Map(environments.map(e => [ref(e.id), e]));
    const folderChains = new Map<string, Obj[]>();
    const folderChain = (id: string | null): Obj[] => {
      if (id === null) return [];
      const cached = folderChains.get(id);
      if (cached) return cached;
      const chain: Obj[] = [], seen = new Set<string>();
      let current: string | null = id;
      while (current !== null) {
        check(!seen.has(current) && seen.size < 24, 'Yaak 目录引用存在环或嵌套超过上限'); seen.add(current);
        const f = folderMap.get(current);
        check(f, 'Yaak 目录引用不存在或跨工作区');
        chain.unshift(f);
        current = f.folderId === undefined || f.folderId === null ? null : ref(f.folderId);
      }
      folderChains.set(id, chain);
      return chain;
    };
    for (const f of folders) folderChain(ref(f.id));
    const parentKind = (e: Obj): string => {
      if (e.parentModel !== undefined) {
        const model = str(e.parentModel);
        check(['workspace', 'environment', 'folder'].includes(model), 'Yaak 环境父级模型无效');
        return model;
      }
      if (e.base !== undefined) return flag(e.base, false) ? 'workspace' : 'environment';
      if (e.environmentId !== undefined) return e.environmentId === null ? 'workspace' : 'environment';
      return 'workspace';
    };
    const parentId = (e: Obj): string | null => {
      const value = e.parentId ?? e.environmentId;
      return value === undefined || value === null ? null : ref(value);
    };
    const roots = environments.filter(e => parentKind(e) === 'workspace');
    check(roots.length <= 1, 'Yaak 包含重复工作区基础环境');
    const legacyVars = vars(rawWorkspace.variables);
    const flattened = new Map<string, Vars>(), visiting = new Set<string>();
    const flatten = (e: Obj): Vars => {
      const id = ref(e.id), cached = flattened.get(id);
      if (cached) return cached;
      check(!visiting.has(id) && visiting.size < 24, 'Yaak 环境继承存在环或超过上限'); visiting.add(id);
      let inherited = new Map(legacyVars);
      const kind = parentKind(e), pid = parentId(e);
      if (kind === 'environment') {
        const parent = pid === null ? roots[0] : environmentMap.get(pid);
        check(pid === null || parent, 'Yaak 环境父级引用不存在或跨工作区');
        if (parent) inherited = new Map(flatten(parent));
      } else if (kind === 'folder') {
        check(pid && folderMap.has(pid), 'Yaak 环境目录引用不存在或跨工作区');
        if (roots[0]) inherited = new Map(flatten(roots[0]));
      } else check(pid === null || pid === wid, 'Yaak 环境工作区父级引用无效');
      for (const [name, v] of vars(e.variables)) inherited.set(name, v);
      visiting.delete(id); flattened.set(id, inherited);
      return inherited;
    };
    for (const e of environments) flatten(e);
    const globalEnvs = environments.filter(e => parentKind(e) !== 'folder');
    const envs = globalEnvs.length
      ? globalEnvs.map(e => b.environment(projectId, str(e.name, '默认环境'), flatten(e)))
      : [b.environment(projectId, '默认环境', legacyVars)];
    const rootScope = scope(rawWorkspace, { headers: [], timeout: 30000 });
    const folderInstances = new Map<string, string>();
    const ensureFolder = (serviceId: string, chain: Obj[]) => {
      let parentId: string | null = null;
      for (const f of chain) {
        const key = JSON.stringify([serviceId, f.id]);
        let current = folderInstances.get(key);
        if (!current) {
          b.reserve();
          current = uid(); folderInstances.set(key, current);
          b.workspace.folders.push({ id: current, serviceId, parentId, name: str(f.name, '目录') });
        }
        parentId = current;
      }
      return parentId;
    };
    for (const raw of requests) {
      const chain = folderChain(raw.folderId === undefined || raw.folderId === null ? null : ref(raw.folderId));
      let inherited = rootScope;
      for (const f of chain) inherited = scope(f, inherited);
      const effective = scope(raw, inherited);
      const folderVars: Vars = new Map();
      for (const f of chain) for (const e of environments.filter(e => parentKind(e) === 'folder' && parentId(e) === f.id)) {
        for (const [name, v] of vars(e.variables)) folderVars.set(name, v);
      }
      const effectiveEnvs = folderVars.size ? envs.map(env => ({
        environment: env.environment,
        variables: new Map([...env.variables, ...[...folderVars].map(([name, v]) => [name, v.secret ? '' : v.value] as [string, string])]),
      })) : envs;
      const built = b.request(projectId, str(raw.name, '请求'), convert(str(raw.url)), effectiveEnvs, folderVars.size ? JSON.stringify(chain.map(f => f.id)) : '');
      if (!built) continue;
      const { request: r, rawQuery } = built;
      r.folderId = ensureFolder(r.serviceId, chain); r.method = str(raw.method, 'GET');
      r.headers = effective.headers; r.timeoutMs = effective.timeout;
      if (effective.auth) r.auth = structuredClone(effective.auth);
      r.query = rawQuery;
      const paramsSeen = new Set<string>();
      for (const value of list(raw.urlParameters)) {
        const p = obj(value), name = str(p.name), enabled = flag(p.enabled, true);
        if (p.id !== undefined) { const id = ref(p.id); check(!paramsSeen.has(id), 'Yaak 参数行 ID 重复'); paramsSeen.add(id); }
        const valueString = convert(str(p.value, ''));
        if (name.startsWith(':') && r.path.split('/').includes(name)) {
          if (enabled) {
            const variableName = `yaak_path_${paramsSeen.size}_${uid().replaceAll('-', '')}`;
            r.path = r.path.split('/').map(s => s === name ? `{{${variableName}}}` : s).join('/');
            // Direct variable templates keep the shared request path readable.
            if (/^\{\{[^{}]+\}\}$/.test(valueString)) r.path = r.path.replaceAll(`{{${variableName}}}`, valueString);
            else b.variable(projectId, 'request', r.id, variableName, valueString);
          }
        } else r.query.push(pair(name, valueString, enabled));
      }
      for (const [name, v] of folderVars) b.variable(projectId, 'request', r.id, name, v.value, v.secret);
      convertBody(raw, r, b);
      if (raw.preRequestScript !== undefined || raw.postRequestScript !== undefined || raw.script !== undefined) b.warnings.add('Yaak 脚本不受支持，已忽略；不会执行脚本。');
      b.addRequest(r);
    }
    // Retain empty folders as well; a collection consisting only of folders is useful.
    if (folders.length) {
      const services = b.workspace.services.filter(s => s.projectId === projectId);
      const serviceIds = services.length ? services.map(s => s.id) : [b.service(projectId, '', envs)];
      for (const sid of serviceIds) for (const f of folders) ensureFolder(sid, folderChain(ref(f.id)));
    }
    if (!requests.length && (local('grpcRequests').length || local('websocketRequests').length)) b.warnings.add('该 Yaak 工作区没有可转换的 HTTP 请求，仅保留项目、环境和目录。');
  }
  return b;
}

function convertBody(raw: Obj, r: RequestDefinition, b: Builder) {
  const type = raw.bodyType;
  if (type === undefined || type === null || type === '') return;
  const body = raw.body === undefined ? {} : obj(raw.body);
  const convert = (v: unknown) => yaakTemplate(str(v, ''), b.warnings);
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    r.bodyType = type === 'multipart/form-data' ? 'multipart' : 'form';
    r.form = list(body.form).map(value => {
      const f = obj(value), file = f.file !== undefined && f.file !== null;
      if (file) b.warnings.add('本地文件上传字段已清空并禁用，请重新选择文件。');
      return { id: uid(), key: str(f.name), value: file ? '' : convert(f.value), enabled: file ? false : flag(f.enabled, true), kind: file ? 'file' : 'text' };
    });
  } else if (type === 'application/json' || type === 'text/plain' || type === 'application/xml' || type === 'text/xml' || (typeof type === 'string' && type.endsWith('+json'))) {
    r.bodyType = type === 'application/json' || type.endsWith('+json') ? 'json' : 'text';
    r.body = convert(body.text);
    if (!r.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type')) {
      r.headers.push(pair('Content-Type', type));
    }
  } else if (type === 'graphql') {
    r.bodyType = 'json'; r.body = convert(body.text);
    b.warnings.add('Yaak GraphQL 正文已保留为 JSON 文本，请检查 Content-Type。');
  } else if (type === 'binary') b.warnings.add('Yaak 二进制文件正文不受支持，已清空，请重新选择文件。');
  else b.warnings.add('部分 Yaak 正文类型不受支持，已清空，请手动配置。');
}
