import { isAlias, parseAllDocuments, visit } from 'yaml';
import type { Pair, RequestDefinition, Workspace } from '../types';
import type { ImportBundle } from './transfer';
import { importSelection } from './transfer';
import { check, list, MAX_ENTITIES, obj, pair, safeTree, str, textLimit, type Obj } from './transfer-adapters/shared';
import { emptyWorkspace, newRequest, uid } from './workspace';

export interface OpenApiDocument { bundle: ImportBundle }
export interface OpenApiTarget { projectId: string; serviceId: string }
export interface OpenApiRow {
  key: string; label: string;
  kind: 'added' | 'changed' | 'unchanged' | 'removed' | 'blocked';
  updates: string[]; warnings: string[];
}
export interface OpenApiPreview { rows: OpenApiRow[]; warnings: string[]; mode: 'new' | 'update' }

interface Operation { key: string; label: string; request: RequestDefinition; warnings: string[]; blocked: boolean }
interface Parsed { bundle: ImportBundle; operations: Operation[] }
interface Plan {
  base: string; parsed: Parsed; target?: OpenApiTarget; rows: OpenApiRow[];
  patches: Map<string, RequestDefinition>;
}
// Plans are ephemeral capabilities, never persisted or accepted from JSON/IPC.
// Caller edits to displayed rows/bundles cannot replace the checked plan.
const documents = new WeakMap<OpenApiDocument, Parsed>();
const plans = new WeakMap<OpenApiPreview, Plan>();
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const keyOf = (r: Pick<RequestDefinition, 'method' | 'path'>) => `${r.method} ${r.path}`;
function safePath(path: string) {
  check(!/%(?![0-9a-f]{2})/i.test(path), '路径百分号编码无效');
  for (const segment of path.split('/')) {
    const decoded = segment.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    check(decoded !== '.' && decoded !== '..' && !decoded.includes('\\'), '路径包含点段或反斜线');
  }
}
const sensitive = (name: string) => /(?:authorization|cookie|token|apikey|secret|password|passwd|credential|sessionid|signature)$/.test(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
  || ['key', 'auth', 'session', 'sid', 'pwd', 'xcsrf', 'xsrftoken'].includes(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
class Unsupported extends Error {}
function unsupported(message: string): never { throw new Unsupported(message); }
function snapshot(workspace: Workspace): string {
  safeTree(workspace);
  const text = JSON.stringify(workspace);
  textLimit(text);
  return text;
}

function readDocument(text: string): Obj {
  textLimit(text);
  // The YAML parser also reads JSON and rejects duplicate JSON object keys.
  const docs = parseAllDocuments(text.replace(/^\uFEFF/, ''), { schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false });
  check(docs.length === 1, '仅支持单个 JSON/YAML OpenAPI 文档');
  const doc = docs[0];
  check(!doc.errors.length && !doc.warnings.length, 'JSON/YAML 无效或含重复字段');
  let nodes = 0;
  visit(doc, { Node(_key, node, path) {
    check(++nodes <= 300000 && path.length <= 32, 'JSON/YAML 节点数量或嵌套超过上限');
    check(!isAlias(node) && !node.tag, 'YAML 不允许别名或自定义标签');
  } });
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  safeTree(value);
  return obj(value);
}

/**
 * Offline request subset of OAS 3.0/3.1 and Swagger 2, not a general OAS
 * validator. See official specs: spec.openapis.org/oas/{v3.1.1,v3.0.4,v2.0}.html.
 * No resource loader, network, shell, expression evaluation or file access.
 */
export function parseOpenApi(text: string): OpenApiDocument {
  const root = readDocument(text);
  const swagger = root.swagger === '2.0';
  check(swagger || (typeof root.openapi === 'string' && /^3\.(0|1)\.\d+$/.test(root.openapi)), '仅支持 OpenAPI 3.0/3.1 或 Swagger 2.0');
  const info = obj(root.info), title = str(info.title).trim();
  check(title && title.length <= 1024, 'OpenAPI info.title 无效');
  str(info.version);
  const paths = obj(root.paths);
  const warnings = new Set<string>([
    '仅导入 HTTP 请求结构；响应、描述、链接、回调、Webhook、外部文档及扩展不保存，不执行任何脚本或网络请求。',
    '已清空已知凭据字段；普通正文、路径、名称仍可能含业务数据，请人工检查。',
    'Schema 仅生成基础样例，不保证满足长度、范围、格式或只读字段等约束，请检查后填写测试数据。',
  ]);
  const w = emptyWorkspace(), projectId = uid(), serviceId = uid(), environmentId = uid();
  w.activeProjectId = projectId;
  w.projects.push({ id: projectId, name: title, activeEnvironmentId: environmentId });
  w.services.push({ id: serviceId, projectId, name: title });
  w.environments.push({ id: environmentId, projectId, name: '导入环境', isProduction: false });
  const operations: Operation[] = [], folderIds = new Map<string, string>();
  let budget = 0;
  const spend = () => { if (++budget > MAX_ENTITIES) unsupported('引用展开/样例节点预算超过上限'); };
  const resolve = (value: unknown, chain: string[] = []): { value: Obj; chain: string[] } => {
    spend();
    if (chain.length >= 16) unsupported('本地引用深度预算超过上限');
    const item = obj(value);
    if (item.$ref === undefined) return { value: item, chain };
    const ref = str(item.$ref);
    if (!ref.startsWith('#/')) unsupported('不支持外部引用或非 JSON Pointer 引用；不会读取网络或文件');
    if (chain.includes(ref)) unsupported('本地引用存在循环，已阻止该接口');
    if (Object.keys(item).some(k => !['$ref', 'summary', 'description'].includes(k))) unsupported('不支持带行为字段的 $ref 同级内容');
    let current: unknown = root;
    let pointer: string;
    try { pointer = decodeURIComponent(ref.slice(2)); } catch { unsupported('本地引用 URI 转义无效'); }
    for (const encoded of pointer.split('/')) {
      if (/~(?![01])/.test(encoded)) unsupported('本地引用 JSON Pointer 转义无效');
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (['__proto__', 'constructor', 'prototype'].includes(key)) unsupported('本地引用字段不安全');
      const o = obj(current);
      if (!Object.hasOwn(o, key)) unsupported('本地引用不存在，已阻止该接口');
      current = o[key];
    }
    return resolve(current, [...chain, ref]);
  };
  // Report external refs even in response/components which we do not expand.
  const scan = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      const o = obj(value);
      if (typeof o.$ref === 'string' && !o.$ref.startsWith('#/')) warnings.add('文档包含外部引用；不会读取网络或本地文件，受影响的请求项会被阻止。');
      if (o.security !== undefined || o.securityDefinitions !== undefined || o.securitySchemes !== undefined) warnings.add('文档安全方案/鉴权不自动应用，凭据需手动配置；更新保留本地鉴权。');
    }
    for (const child of Object.values(value)) scan(child);
  };
  scan(root);
  const cleanExample = (value: unknown, depth = 0): unknown => {
    spend();
    if (depth > 12) unsupported('样例深度预算超过上限');
    if (Array.isArray(value)) return value.map(v => cleanExample(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(obj(value)).map(([k, v]) => {
      if (sensitive(k)) { warnings.add('正文/参数样例中的已知凭据已清空。'); return [k, '']; }
      return [k, cleanExample(v, depth + 1)];
    }));
    // Template-looking document data must not become local variable references.
    if (typeof value === 'string' && value.includes('{{')) { warnings.add('样例中的模板表达式已清空，不导入对本地变量的引用。'); return ''; }
    return value;
  };
  const sample = (raw: unknown, chain: string[] = [], depth = 0): unknown => {
    spend();
    if (depth > 8) unsupported('Schema 样例深度预算超过上限');
    const { value: s, chain: nextChain } = resolve(raw, chain);
    if (['allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else', '$id', '$schema', '$anchor', '$dynamicRef', '$recursiveRef', 'unevaluatedProperties', 'patternProperties', 'prefixItems', 'contains', 'dependentSchemas'].some(k => s[k] !== undefined)
      || (s.additionalProperties !== undefined && s.additionalProperties !== false)) {
      unsupported('不支持组合/条件/动态或开放对象 Schema，请提供简化文档');
    }
    const types = Array.isArray(s.type) ? s.type : [s.type];
    check(types.every(t => t === undefined || ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(t as string)), 'Schema type 无效');
    let type = s.type;
    if (Array.isArray(type)) {
      const nonNull = type.filter(t => t !== 'null');
      if (nonNull.length !== 1) unsupported('不支持多类型 Schema');
      type = nonNull[0];
    }
    let generated: unknown;
    if (type === 'object' || s.properties !== undefined) {
      const properties = s.properties === undefined ? {} : obj(s.properties);
      const result: Obj = {};
      for (const [name, property] of Object.entries(properties)) {
        const child = sample(property, nextChain, depth + 1);
        if (sensitive(name)) { warnings.add('Schema 已知凭据字段已清空。'); result[name] = ''; }
        else result[name] = child;
      }
      generated = result;
    } else if (type === 'array') {
      check(s.items !== undefined, '数组 Schema 缺少 items'); generated = [sample(s.items, nextChain, depth + 1)];
    } else if (type === 'integer' || type === 'number') generated = 0;
    else if (type === 'boolean') generated = false;
    else if (type === 'null') generated = null;
    else if (type === 'string' || type === undefined) {
      if (s.format === 'binary' || s.format === 'byte') unsupported('不支持二进制正文 Schema');
      generated = '';
    } else unsupported('不支持的 Schema type');
    // Walk/validate all schema children before choosing any overriding example.
    if (s.example !== undefined) return cleanExample(s.example);
    if (s.examples !== undefined) { warnings.add('Schema 多个 examples 仅使用首项。'); return cleanExample(list(s.examples)[0] ?? null); }
    if (s.default !== undefined) return cleanExample(s.default);
    if (s.enum !== undefined) { const values = list(s.enum); check(values.length > 0, 'Schema enum 不能为空'); return cleanExample(values[0]); }
    return generated;
  };
  const example = (media: Obj): unknown => {
    // Validate schema even when an explicit example supplies the eventual body.
    const schemaSample = media.schema !== undefined ? sample(media.schema) : undefined;
    if (media.example !== undefined) return cleanExample(media.example);
    if (media.examples !== undefined) {
      const values = Object.values(obj(media.examples));
      check(values.length > 0, 'examples 不能为空');
      warnings.add('多个 examples 仅使用首项。');
      const value = resolve(values[0]).value;
      if (value.externalValue !== undefined) unsupported('不支持 externalValue 外部样例');
      check(value.value !== undefined, 'Example 缺少 value');
      return cleanExample(value.value);
    }
    if (media.schema !== undefined) return schemaSample;
    unsupported('正文缺少支持的 example/schema');
  };
  const body = (request: RequestDefinition, content: Obj) => {
    const entries = Object.entries(content);
    check(entries.length > 0, 'requestBody content 不能为空');
    if (entries.length > 1) unsupported('不支持一个接口的多个请求媒体类型，请裁剪文档后导入');
    const [type, raw] = entries[0];
    const media = obj(raw);
    if (media.encoding !== undefined) unsupported('不支持自定义正文编码');
    if (type === 'application/json' || /^application\/[^;]+\+json$/.test(type)) {
      request.bodyType = 'json'; request.body = JSON.stringify(example(media), null, 2);
    } else if (type === 'text/plain') {
      const value = example(media);
      check(typeof value === 'string', 'text/plain 样例必须为字符串');
      request.bodyType = 'text'; request.body = value;
    } else unsupported(`不支持请求媒体类型 ${type}`);
  };

  let baseUrl = '';
  if (swagger) {
    const basePath = str(root.basePath, '');
    check(!basePath || (basePath.startsWith('/') && !/[?#\\{}]/.test(basePath)), 'Swagger basePath 无效');
    if (root.host !== undefined) {
      const schemes = root.schemes === undefined ? ['https'] : list(root.schemes).map(v => str(v));
      if (schemes.length > 1) warnings.add('Swagger schemes 仅采用首项；更新不改变绑定地址。');
      baseUrl = `${schemes[0]}://${str(root.host)}${basePath}`;
    } else warnings.add('Swagger 未提供 host；basePath 无法独立作为绑定地址，请填写基础地址。');
  } else if (root.servers !== undefined) {
    const servers = list(root.servers);
    if (servers.length) {
      if (servers.length > 1) warnings.add('多个根 servers 仅采用首个；更新不改变绑定地址。');
      const server = obj(servers[0]);
      baseUrl = str(server.url);
      if (server.variables !== undefined) { warnings.add('服务器变量不展开，请手动填写完整基础地址。'); baseUrl = ''; }
    }
  }
  if (baseUrl) {
    try {
      check(/^https?:\/\/[^/?#@\\\s{}]+(?:\/[^?#\\\s{}]*)?$/i.test(baseUrl));
      safePath(baseUrl.slice(baseUrl.indexOf('://') + 3).split('/').slice(1).join('/'));
      const url = new URL(baseUrl);
      check(url.hostname && !url.username && !url.password);
      for (const segment of url.pathname.split('/')) check(!['.', '..'].includes(decodeURIComponent(segment)) && !decodeURIComponent(segment).includes('\\'));
    } catch {
      warnings.add('服务器地址含凭据、相对路径或不支持内容，已清空；请填写 HTTP(S) 基础地址。'); baseUrl = '';
    }
  }
  if (!baseUrl) warnings.add('新项目基础地址为空，请在环境矩阵中填写；导入不会发送请求。');
  w.bindings.push({ id: uid(), projectId, serviceId, environmentId, baseUrl, enabled: true });

  const pathShapes = new Set<string>();
  for (const [path, rawItem] of Object.entries(paths)) {
    if (path.startsWith('x-')) { warnings.add('paths 扩展内容不导入。'); continue; }
    check(path.startsWith('/') && !path.startsWith('//') && !/[?#\\\u0000-\u0020\u007f]/.test(path), 'OpenAPI path 无效');
    check(!path.includes('{{') && !path.includes('}}'), 'OpenAPI path 必须使用单层 {参数} 语法');
    safePath(path);
    const names = [...path.matchAll(/\{([^{}]+)\}/g)].map(m => m[1]);
    check(!/[{}]/.test(path.replace(/\{[^{}]+\}/g, '')) && names.every(n => n.trim() === n && n.length <= 256), 'OpenAPI 路径参数无效');
    const shape = path.replace(/\{[^{}]+\}/g, '{}');
    check(!pathShapes.has(shape), 'OpenAPI 路径模板层级重复，存在歧义');
    pathShapes.add(shape);
    const convertedPath = path.replace(/\{([^{}]+)\}/g, '{{$1}}');
    let item: Obj;
    try { item = resolve(rawItem).value; }
    catch (failure) {
      if (!(failure instanceof Unsupported)) throw failure;
      warnings.add(`${path}：${failure.message}`);
      // Unknown path item cannot safely imply that local methods were removed.
      const request = { ...newRequest(serviceId), path: convertedPath };
      operations.push({ key: `PATH ${convertedPath}`, label: path, request, blocked: true, warnings: [failure.message] });
      continue;
    }
    for (const field of Object.keys(item)) {
      if (!METHODS.has(field) && !['parameters', 'servers', 'summary', 'description'].includes(field) && !field.startsWith('x-')) {
        unsupported(`不支持 Path Item 字段 ${field}`);
      }
    }
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      check(operations.length < 3000, 'OpenAPI 接口数量超过 3000 上限');
      const op = obj(rawOperation), request = { ...newRequest(serviceId), method: method.toUpperCase(), path: convertedPath };
      request.name = str(op.summary ?? op.operationId, `${request.method} ${path}`).trim();
      check(request.name && request.name.length <= 1024, '接口名称无效');
      const notes: string[] = [];
      const tags = list(op.tags).map(t => str(t).trim());
      check(tags.every(t => t.length > 0 && t.length <= 1024), '接口 tag 无效');
      if (tags.length > 1) notes.push('多个 tag 仅映射第一个目录。');
      const tag = tags[0];
      if (tag) {
        if (!folderIds.has(tag)) { const id = uid(); folderIds.set(tag, id); w.folders.push({ id, serviceId, parentId: null, name: tag }); }
        request.folderId = folderIds.get(tag)!;
      }
      let blocked = false;
      try {
        if (item.servers !== undefined || op.servers !== undefined) unsupported('不支持路径/操作级 servers；不能映射到共享服务地址');
        if (swagger && op.schemes !== undefined) unsupported('不支持操作级 schemes；不能映射到共享服务地址');
        if (op.callbacks !== undefined) notes.push('callbacks 不导入。');
        const combined = new Map<string, Obj>();
        for (const group of [item.parameters, op.parameters]) {
          const local = new Set<string>();
          for (const raw of list(group)) {
            const p = resolve(raw).value;
            const name = str(p.name), location = str(p.in);
            check(name.trim() && !/[\u0000-\u001f\u007f]/.test(name), '参数名称无效');
            for (const field of ['required', 'deprecated', 'allowEmptyValue', 'allowReserved', 'explode']) {
              if (p[field] !== undefined) check(typeof p[field] === 'boolean', `参数 ${field} 必须是布尔值`);
            }
            if (!swagger) check(p.schema !== undefined || p.content !== undefined, 'OpenAPI 参数必须包含 schema 或 content');
            const key = `${location}:${location === 'header' ? name.toLowerCase() : name}`;
            check(!local.has(key), '文档参数重复，存在歧义');
            local.add(key); combined.set(key, p);
          }
        }
        const pathNames = new Set<string>();
        let bodyParameters = 0;
        for (const p of combined.values()) {
          const name = str(p.name), location = str(p.in);
          if (location === 'body' && swagger) {
            check(++bodyParameters === 1, 'Swagger 只能有一个 body 参数');
            const consumes = op.consumes ?? root.consumes ?? ['application/json'];
            const types = list(consumes).map(t => str(t));
            if (types.length !== 1) unsupported('不支持多个 consumes 请求媒体类型');
            body(request, { [types[0]]: { schema: p.schema } }); continue;
          }
          if (!['query', 'header', 'path'].includes(location)) unsupported(`不支持 ${location} 参数`);
          if (location === 'query' && (name.includes('{{') || name.includes('}}'))) unsupported('Query 参数名称不支持模板变量，请手动配置');
          if (p.content !== undefined || p.allowReserved === true) unsupported('不支持参数 content/allowReserved');
          if (p.style !== undefined && p.style !== (location === 'query' ? 'form' : 'simple')) unsupported('不支持参数 style 序列化');
          if (p.collectionFormat !== undefined) unsupported('不支持 collectionFormat 序列化');
          if (location === 'header') check(TOKEN.test(name), 'Header 名称无效');
          if (location === 'path') {
            check(p.required === true && names.includes(name), 'path 参数必须 required 且对应路径模板');
            pathNames.add(name);
          }
          const schema = resolve(p.schema ?? p).value;
          if (schema.properties !== undefined || schema.items !== undefined
            || (Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === 'object' || t === 'array')) {
            unsupported('不支持对象或数组参数序列化');
          }
          const schemaSample = sample(p.schema ?? p);
          const value = p.example !== undefined ? cleanExample(p.example)
            : p.examples !== undefined ? example(p)
              : schemaSample;
          if (value !== null && typeof value === 'object') unsupported('不支持对象或数组参数序列化');
          if (location === 'path') {
            w.variables.push({ id: uid(), projectId, scope: 'request', ownerId: request.id, name, value: '', isSecret: sensitive(name) });
          } else {
            const reserved = !swagger && location === 'header' && ['accept', 'content-type', 'authorization'].includes(name.toLowerCase());
            if (reserved) warnings.add('OAS 特殊 Header（Accept/Content-Type/Authorization）按规范不应用，仅保留禁用空占位。');
            const secret = sensitive(name) || reserved;
            if (secret) warnings.add('Query/Header 已知凭据字段已清空并禁用。');
            const valueText = value === null ? '' : String(value);
            check(!/[\r\n\u0000]/.test(valueText), '参数样例不能包含换行或 NUL');
            request[location === 'query' ? 'query' : 'headers'].push(pair(name, secret ? '' : valueText, !secret));
          }
        }
        check(names.every(name => pathNames.has(name)), '路径模板缺少对应的 required path 参数');
        if (op.requestBody !== undefined) {
          check(!swagger && !bodyParameters, 'Swagger 不支持 requestBody');
          body(request, obj(resolve(op.requestBody).value.content));
        }
      } catch (failure) {
        if (!(failure instanceof Unsupported)) throw failure;
        blocked = true; notes.push(failure.message);
      }
      if (!blocked) w.requests.push(request);
      for (const note of notes) warnings.add(`${request.method} ${path}：${note}`);
      operations.push({ key: keyOf(request), label: `${request.method} ${path}`, request, blocked, warnings: notes });
    }
  }
  check(operations.length > 0, '文档没有可预览的 HTTP 接口');
  // A blocked operation may have generated variables before hitting unsupported
  // content. Never leak these orphan owners into the transferable draft.
  const owners = new Set(w.requests.map(r => r.id));
  w.variables = w.variables.filter(v => owners.has(v.ownerId));
  const bundle: ImportBundle = { source: swagger ? 'Swagger 2.0' : `OpenAPI ${root.openapi}`, workspace: w, warnings: [...warnings] };
  importSelection(emptyWorkspace(), bundle, { [projectId]: [environmentId] });
  const parsed = { bundle, operations };
  const result = { bundle: structuredClone(bundle) };
  documents.set(result, parsed);
  return result;
}

function mergeRequest(local: RequestDefinition, incoming: RequestDefinition, workspace: Workspace, row: OpenApiRow): RequestDefinition {
  const result = { ...local };
  if (local.name !== incoming.name) row.warnings.push(`本地名称「${local.name}」与文档「${incoming.name}」冲突，保留本地名称。`);
  const folderName = (id: string | null) => workspace.folders.find(f => f.id === id)?.name ?? '';
  // Incoming folder IDs belong to the detached document; caller reports tag separately.
  if (incoming.folderId) row.warnings.push(`文档 tag 目录不迁移，本地目录「${folderName(local.folderId) || '根目录'}」保留。`);
  for (const field of ['query', 'headers'] as const) {
    const normalize = (key: string) => field === 'headers' ? key.toLowerCase() : key;
    const old = new Map<string, Pair[]>();
    for (const p of local[field]) old.set(normalize(p.key), [...(old.get(normalize(p.key)) ?? []), p]);
    const docKeys = new Set(incoming[field].map(p => normalize(p.key)));
    const added = incoming[field].filter(p => !old.has(normalize(p.key))).map(p => ({ ...p, id: uid() }));
    result[field] = [...local[field], ...added];
    for (const p of added) row.updates.push(`补齐 ${field === 'query' ? 'Query' : 'Header'}：${p.key}${p.enabled ? '' : '（凭据留空禁用）'}`);
    for (const [key, values] of old) {
      if (values.length > 1) row.warnings.push(`本地 ${field} 参数 ${values[0].key} 重复，全部保留。`);
      if (!docKeys.has(key)) row.warnings.push(`文档已移除或未列出 ${field} 参数 ${values[0].key}，保留本地值。`);
      else if (incoming[field].some(p => normalize(p.key) === key && values.some(v => v.value !== p.value || v.enabled !== p.enabled))) {
        row.warnings.push(`${field} 参数 ${values[0].key} 的值/启用状态冲突，保留本地值。`);
      }
    }
  }
  if (incoming.bodyType !== local.bodyType || incoming.body !== local.body) row.warnings.push('文档正文/样例有差异，保留本地 body/form 测试数据。');
  if (local.environmentConfigs) row.warnings.push('所有 environmentConfigs 原样保留；新增字段仅补共享模板，已有环境覆盖需手动补齐。');
  return result;
}

export function previewOpenApi(workspace: Workspace, document: OpenApiDocument, target?: OpenApiTarget): OpenApiPreview {
  const parsed = documents.get(document);
  check(parsed, '请先解析有效的 OpenAPI 文档');
  const base = snapshot(workspace);
  if (target) {
    check(workspace.projects.filter(p => p.id === target.projectId).length === 1
      && workspace.services.filter(s => s.id === target.serviceId).length === 1
      && workspace.services.some(s => s.id === target.serviceId && s.projectId === target.projectId), '目标项目/服务不存在或存在歧义，请重新选择');
  }
  const locals = target ? workspace.requests.filter(r => r.serviceId === target.serviceId) : [];
  const rows: OpenApiRow[] = [], patches = new Map<string, RequestDefinition>();
  const seen = new Set<string>();
  for (const op of parsed.operations) {
    const matched = locals.filter(r => keyOf(r) === op.key);
    const row: OpenApiRow = { key: op.key, label: op.label, kind: 'added', updates: [], warnings: [...op.warnings] };
    seen.add(op.key);
    const duplicateId = matched.some(r => workspace.requests.filter(other => other.id === r.id).length > 1);
    const incomingFolder = parsed.bundle.workspace.folders.find(f => f.id === op.request.folderId);
    const duplicateFolder = target && !matched.length && incomingFolder
      && workspace.folders.filter(f => f.serviceId === target.serviceId && f.parentId === null && f.name === incomingFolder.name).length > 1;
    if (op.blocked || matched.length > 1 || duplicateId || duplicateFolder) {
      row.kind = 'blocked';
      if (matched.length > 1) row.warnings.push('相同 method/path 匹配多个本地接口，存在歧义，阻止该项。');
      if (duplicateId) row.warnings.push('本地请求身份重复，阻止该项。');
      if (duplicateFolder) row.warnings.push('本地根目录重名，新增接口目录存在歧义，阻止该项。');
    } else if (matched.length === 1) {
      patches.set(op.key, mergeRequest(matched[0], op.request, workspace, row));
      row.kind = row.updates.length || row.warnings.length ? 'changed' : 'unchanged';
    } else {
      row.updates.push('创建接口草稿、Query/Header、文档正文样例及空路径变量；新目录按首个 tag 创建。');
    }
    rows.push(row);
  }
  for (const local of locals) if (!seen.has(keyOf(local))) {
    rows.push({ key: `removed:${local.id}`, label: keyOf(local), kind: 'removed', updates: [], warnings: ['文档已移除/未列出；也可能是本地自建接口，仅提示，绝不自动删除。'] });
  }
  const result: OpenApiPreview = { mode: target ? 'update' : 'new', rows: structuredClone(rows), warnings: [...parsed.bundle.warnings] };
  plans.set(result, { base, parsed, target: target ? { ...target } : undefined, rows, patches });
  return Object.freeze(result);
}

export function applyOpenApiPreview(workspace: Workspace, preview: OpenApiPreview, selectedKeys: string[]): Workspace {
  const plan = plans.get(preview);
  check(plan, '预览无效，请重新解析');
  check(snapshot(workspace) === plan.base, '工作区已变更，预览已过期，请重新预览后确认');
  safeTree(selectedKeys);
  const keys = new Set(selectedKeys);
  check(keys.size > 0 && keys.size === selectedKeys.length, '请选择可应用的接口且不要重复选择');
  for (const key of keys) check(plan.rows.some(row => row.key === key && ['added', 'changed'].includes(row.kind)), '选中项存在歧义、已移除或被阻止');
  const chosen = plan.parsed.operations.filter(op => keys.has(op.key));
  const bundle = structuredClone(plan.parsed.bundle);
  const requestIds = new Set(chosen.map(op => op.request.id));
  bundle.workspace.requests = bundle.workspace.requests.filter(r => requestIds.has(r.id));
  bundle.workspace.variables = bundle.workspace.variables.filter(v => requestIds.has(v.ownerId));
  if (!plan.target) {
    const p = bundle.workspace.projects[0];
    return importSelection(workspace, bundle, { [p.id]: bundle.workspace.environments.map(e => e.id) });
  }
  const next = structuredClone(workspace);
  const { projectId, serviceId } = plan.target;
  const folders = new Map<string, string>();
  for (const f of next.folders.filter(f => f.serviceId === serviceId && f.parentId === null)) {
    // Relevant ambiguities were blocked at preview; unrelated folders survive.
    folders.set(f.name, f.id);
  }
  for (const op of chosen) {
    const patch = plan.patches.get(op.key);
    if (patch) {
      next.requests = next.requests.map(r => r.id === patch.id ? structuredClone(patch) : r);
      continue;
    }
    const request = structuredClone(op.request);
    const oldId = request.id;
    request.id = uid(); request.serviceId = serviceId;
    request.query = request.query.map(p => ({ ...p, id: uid() }));
    request.headers = request.headers.map(p => ({ ...p, id: uid() }));
    const folder = bundle.workspace.folders.find(f => f.id === request.folderId);
    request.folderId = null;
    if (folder) {
      let id = folders.get(folder.name);
      if (!id) { id = uid(); folders.set(folder.name, id); next.folders.push({ id, serviceId, parentId: null, name: folder.name }); }
      request.folderId = id;
    }
    next.requests.push(request);
    next.variables.push(...bundle.workspace.variables.filter(v => v.ownerId === oldId).map(v => ({ ...v, id: uid(), projectId, ownerId: request.id })));
  }
  // Do not run imported local data through credential scrubbers: existing local
  // credentials/configs must survive byte-for-byte. Only additions came through
  // the import validator above; this checks aggregate resource budgets.
  snapshot(next);
  return next;
}
