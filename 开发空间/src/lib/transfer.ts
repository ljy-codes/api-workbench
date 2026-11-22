import type { RequestConfig, Workspace } from '../types';
import { isAlias, parseAllDocuments, visit } from 'yaml';
import { exportProject, importProject } from './exchange';
import { emptyWorkspace, uid } from './workspace';
import { check, COLLECTIONS, exact, list, MAX_ENTITIES, obj, ref, REVIEW_WARNING, safeTree, str, textLimit } from './transfer-adapters/shared';
import { fromPostman } from './transfer-adapters/postman';
import { fromYaak } from './transfer-adapters/yaak';

export type TransferSelection = Record<string, string[]>;
export interface ImportBundle { source: string; workspace: Workspace; warnings: string[] }
const FORMAT = 'envdock-transfer';
const envelope = (workspace: Workspace) => JSON.stringify({ format: FORMAT, version: 1, workspace });

function parse(text: string): unknown {
  textLimit(text);
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { throw new Error('转换文件不是有效的 JSON'); }
    safeTree(value);
    return value;
  }
  try {
    const documents = parseAllDocuments(trimmed, { schema: 'core', uniqueKeys: true, prettyErrors: false, strict: true });
    check(documents.length > 0 && documents.length <= 10000, 'YAML 文档数量无效');
    const values = documents.map(doc => {
      check(!doc.errors.length && !doc.warnings.length, 'YAML 结构或类型无效');
      visit(doc, { Node(_key, node, path) {
        check(path.length <= 32, 'YAML 嵌套超过上限');
        check(!isAlias(node) && !node.tag, 'YAML 不允许别名或自定义标签');
      } });
      const value: unknown = doc.toJS({ maxAliasCount: 0 });
      safeTree(value);
      return value;
    });
    return values.length === 1 ? values[0] : values;
  } catch { throw new Error('YAML 文件无效、含不安全结构或超过上限'); }
}

/**
 * Cross-project checks precede exportProject: filtering a project must never hide
 * orphaned entities or duplicate IDs in a different project. That existing boundary
 * then validates every field, local row namespace, cycle and owner reference.
 */
function validated(value: unknown, allowEmpty = false): Workspace {
  safeTree(value);
  const o = obj(value);
  exact(o, ['revision', 'activeProjectId', ...COLLECTIONS]);
  for (const key of COLLECTIONS) list(o[key]);
  const w = value as Workspace;
  check(Number.isSafeInteger(w.revision) && w.revision >= 0, '工作区 revision 无效');
  check(allowEmpty || w.projects.length > 0, '转换文件必须包含项目');
  if (w.activeProjectId !== null) ref(w.activeProjectId);
  const ids = new Set<string>();
  let count = 0;
  const entity = (value: unknown, unique = true) => {
    const e = obj(value), id = ref(e.id);
    check(++count <= MAX_ENTITIES, '转换文件总实体数量超过上限');
    if (unique) { check(!ids.has(id), '转换文件包含重复 ID'); ids.add(id); }
  };
  const rows = (v: unknown, unique = true) => { for (const p of list(v)) entity(p, unique); };
  for (const key of COLLECTIONS) rows(w[key]);
  const projects = new Set(w.projects.map(p => p.id));
  const serviceProjects = new Map(w.services.map(s => [s.id, s.projectId]));
  for (const e of [...w.environments, ...w.services, ...w.bindings, ...w.variables]) check(projects.has(e.projectId), '转换文件项目引用不存在');
  for (const e of [...w.folders, ...w.requests]) check(serviceProjects.has(e.serviceId), '转换文件服务引用不存在');
  for (const s of w.services) rows(s.headers);
  for (const r of w.requests) {
    rows(r.query); rows(r.headers); rows(r.form);
    if (r.environmentConfigs !== undefined) {
      const configs = obj(r.environmentConfigs);
      check(Object.keys(configs).length <= 10000, '环境配置数量超过上限');
      for (const c of Object.values(configs)) {
        check(++count <= MAX_ENTITIES, '转换文件总实体数量超过上限');
        const config = obj(c);
        rows(config.query, false); rows(config.headers, false); rows(config.form, false);
      }
    }
  }
  const clean = emptyWorkspace();
  clean.revision = w.revision;
  for (const p of w.projects) {
    const single = JSON.parse(exportProject(w, p.id)).project as Workspace;
    for (const key of COLLECTIONS) (clean[key] as unknown[]).push(...single[key]);
  }
  clean.activeProjectId = projects.has(w.activeProjectId ?? '') ? w.activeProjectId : clean.projects[0]?.id ?? null;
  // Scrubbing may add credential variables: enforce limits on the actual result.
  check(count + clean.variables.length - w.variables.length <= MAX_ENTITIES, '脱敏后实体数量超过上限');
  textLimit(envelope(clean));
  return clean;
}

function selected(w: Workspace, selection: TransferSelection): Workspace {
  safeTree(selection);
  const choices = Object.entries(obj(selection));
  check(choices.length > 0, '请选择至少一个项目');
  const projectIds = new Set(w.projects.map(p => p.id));
  const selectedProjects = new Set<string>(), environments = new Set<string>();
  for (const [projectId, value] of choices) {
    check(projectIds.has(projectId), '选择的项目不存在');
    selectedProjects.add(projectId);
    const seen = new Set<string>();
    for (const rawId of list(value)) {
      const environmentId = ref(rawId);
      check(!seen.has(environmentId) && w.environments.some(e => e.id === environmentId && e.projectId === projectId), '选择的环境重复、不存在或不属于项目');
      seen.add(environmentId); environments.add(environmentId);
    }
  }
  const result = structuredClone(w);
  result.projects = result.projects.filter(p => selectedProjects.has(p.id));
  result.environments = result.environments.filter(e => environments.has(e.id));
  result.services = result.services.filter(s => selectedProjects.has(s.projectId));
  const services = new Set(result.services.map(s => s.id));
  result.bindings = result.bindings.filter(b => selectedProjects.has(b.projectId) && environments.has(b.environmentId));
  const bindings = new Set(result.bindings.map(b => b.id));
  result.folders = result.folders.filter(f => services.has(f.serviceId));
  for (const p of result.projects) {
    if (!environments.has(p.activeEnvironmentId ?? '')) p.activeEnvironmentId = result.environments.find(e => e.projectId === p.id)?.id ?? null;
  }
  const projects = new Map(result.projects.map(p => [p.id, p]));
  const serviceProjects = new Map(result.services.map(s => [s.id, s.projectId]));
  const neutral = (): RequestConfig => ({ query: [], headers: [], bodyType: 'none', body: '', timeoutMs: 30000 });
  let generatedConfigs = 0;
  result.requests = result.requests.filter(r => services.has(r.serviceId)).map(r => {
    if (!r.environmentConfigs) return r;
    const configs = Object.fromEntries(Object.entries(r.environmentConfigs).filter(([id]) => environments.has(id)));
    const projectId = serviceProjects.get(r.serviceId)!;
    for (const e of result.environments.filter(e => e.projectId === projectId)) {
      if (!Object.hasOwn(configs, e.id)) {
        check(++generatedConfigs <= MAX_ENTITIES, '裁剪生成的环境配置数量超过上限');
        configs[e.id] = neutral();
      }
    }
    const active = projects.get(projectId)!.activeEnvironmentId;
    const primary = active ? configs[active] : undefined;
    // A variant-bearing request's legacy template can contain another environment.
    // Only selected variants may provide the fallback template.
    const config = primary ? structuredClone(primary) : neutral();
    const { environmentConfigs: _configs, auth: _auth, form: _form, ...base } = r;
    // Top-level Pair IDs share a global namespace; variants have local namespaces.
    const template = {
      ...config, query: config.query.map(p => ({ ...p, id: uid() })), headers: config.headers.map(p => ({ ...p, id: uid() })),
      ...(config.form ? { form: config.form.map(p => ({ ...p, id: uid() })) } : {}),
    };
    return { ...base, ...template, ...(Object.keys(configs).length ? { environmentConfigs: configs } : {}) };
  });
  result.variables = result.variables.filter(v => selectedProjects.has(v.projectId)
    && (v.scope !== 'environment' || environments.has(v.ownerId)) && (v.scope !== 'binding' || bindings.has(v.ownerId)));
  result.activeProjectId = selectedProjects.has(result.activeProjectId ?? '') ? result.activeProjectId : result.projects[0].id;
  return result;
}

/** Pure, offline preview. It never reads files, executes scripts or resolves network URLs. */
export function detectImport(text: string): ImportBundle {
  const value = parse(text);
  let source: string, workspace: Workspace, warnings: string[] = [REVIEW_WARNING];
  if (!Array.isArray(value) && obj(value).format === 'api-workbench') {
    workspace = importProject(emptyWorkspace(), JSON.stringify(value));
    source = `envdock-v${obj(value).version}`;
  } else if (!Array.isArray(value) && obj(value).format === FORMAT) {
    const root = obj(value);
    exact(root, ['format', 'version', 'workspace']);
    check(root.version === 1, '不支持的多项目交换版本');
    workspace = root.workspace as Workspace; source = 'envdock-transfer-v1';
  } else if (!Array.isArray(value) && (obj(value).info !== undefined || obj(value)._postman_variable_scope === 'environment')) {
    const result = fromPostman(obj(value));
    workspace = result.finish(); warnings = [...result.warnings]; source = 'postman';
  } else {
    const result = fromYaak(value);
    workspace = result.finish(); warnings = [...result.warnings]; source = 'yaak';
  }
  return { source, workspace: validated(workspace), warnings };
}

/** Validate the complete preview again, then import into a detached result atomically. */
export function importSelection(target: Workspace, bundle: ImportBundle, selection: TransferSelection): Workspace {
  safeTree(bundle);
  exact(obj(bundle), ['source', 'workspace', 'warnings']);
  str(bundle.source);
  for (const warning of list(bundle.warnings)) str(warning);
  const source = validated(bundle.workspace);
  const chosen = validated(selected(source, selection));
  validated(target, true);
  let next = target;
  for (const p of chosen.projects) next = importProject(next, exportProject(chosen, p.id));
  // Each side may fit independently while the detached merged result exceeds limits.
  validated(next);
  return next;
}

/** Empty environment arrays mean project structure without any environment. */
export function exportSelection(workspace: Workspace, selection: TransferSelection): string {
  const selectedWorkspace = validated(selected(validated(workspace), selection));
  const text = JSON.stringify({ format: FORMAT, version: 1, workspace: selectedWorkspace }, null, 2);
  textLimit(text);
  return text;
}
