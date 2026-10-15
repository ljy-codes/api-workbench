import { describe, expect, it } from 'vitest';
import type { RequestConfig, Workspace } from '../types';
import { exportProject } from './exchange';
import { demoWorkspace, emptyWorkspace } from './workspace';
import { detectImport, exportSelection, importSelection } from './transfer';

function fixture(): Workspace {
  const w = demoWorkspace();
  w.revision = 8;
  const r = w.requests[0];
  const config = (body: string): RequestConfig => ({
    query: [], headers: [], bodyType: 'json', body, timeoutMs: 30000,
  });
  r.body = 'UNSELECTED-TOP-TEMPLATE';
  r.environmentConfigs = { 'demo-dev': config('dev-only'), 'demo-prod': config('prod-only') };
  w.bindings.push({ ...w.bindings[0], id: 'prod-binding', environmentId: 'demo-prod', baseUrl: 'https://prod.example.com' });
  w.variables.push(
    { id: 'dev-var', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'stage', value: 'dev', isSecret: false },
    { id: 'prod-var', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-prod', name: 'stage', value: 'prod', isSecret: false },
    { id: 'binding-var', projectId: 'demo-project', scope: 'binding', ownerId: 'prod-binding', name: 'bound', value: 'prod-only-var', isSecret: false },
  );
  return w;
}
const all = (w: Workspace) => Object.fromEntries(w.projects.map(p => [p.id, w.environments.filter(e => e.projectId === p.id).map(e => e.id)]));
const native = (w: Workspace) => JSON.stringify({ format: 'envdock-transfer', version: 1, workspace: w });

describe('transfer selection boundary', () => {
  it.each([1, 2])('reads existing v%s and scrubs preview credentials', version => {
    const w = demoWorkspace();
    w.requests[0].auth = { kind: 'bearer', token: 'PRIVATE_TOKEN' };
    const bundle = detectImport(JSON.stringify({ format: 'api-workbench', version, project: w }));
    expect(bundle.workspace.projects).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE_TOKEN');
    const next = importSelection(w, bundle, all(bundle.workspace));
    expect(next.projects).toHaveLength(2);
    expect(next.revision).toBe(w.revision);
    expect(next.projects[1].id).not.toBe(bundle.workspace.projects[0].id);
  });

  it('round trips multiple projects, prunes relations and replaces the unselected top template', () => {
    const w = fixture();
    const second = emptyWorkspace();
    second.projects.push({ id: 'p2', name: '第二项目', activeEnvironmentId: null });
    w.projects.push(...second.projects);
    const before = structuredClone(w);
    const text = exportSelection(w, { 'demo-project': ['demo-dev'], p2: [] });
    expect(JSON.parse(text)).toMatchObject({ format: 'envdock-transfer', version: 1 });
    for (const omitted of ['prod-only', 'UNSELECTED-TOP-TEMPLATE', 'prod.example.com', 'prod-only-var']) expect(text).not.toContain(omitted);
    const b = detectImport(text);
    expect(b.workspace.projects).toHaveLength(2);
    expect(b.workspace.environments).toHaveLength(1);
    expect(b.workspace.bindings).toHaveLength(1);
    expect(b.workspace.requests[0].body).toBe('dev-only');
    expect(Object.keys(b.workspace.requests[0].environmentConfigs!)).toEqual([b.workspace.environments[0].id]);
    const target = demoWorkspace();
    const snapshot = structuredClone(target);
    const next = importSelection(target, b, all(b.workspace));
    expect(next.projects).toHaveLength(3);
    expect(next.projects[1].activeEnvironmentId).toBe(next.environments[2].id);
    expect(next.requests[2].path).toBe(w.requests[0].path);
    expect(target).toEqual(snapshot);
    expect(w).toEqual(before);
  });

  it('empty environment selection removes environment bodies, variables and bindings', () => {
    const text = exportSelection(fixture(), { 'demo-project': [] });
    const w = detectImport(text).workspace;
    expect(w.environments).toEqual([]);
    expect(w.bindings).toEqual([]);
    expect(w.variables).toEqual([]);
    expect(w.projects[0].activeEnvironmentId).toBeNull();
    expect(w.requests[0].body).toBe('');
    expect(w.requests[0].environmentConfigs).toBeUndefined();
  });

  it('a selected environment missing a variant cannot inherit an unselected body', () => {
    const w = fixture();
    delete w.requests[0].environmentConfigs!['demo-dev'];
    expect(exportSelection(w, { 'demo-project': ['demo-dev'] })).not.toContain('UNSELECTED-TOP-TEMPLATE');
  });

  it.each([
    {}, { missing: [] }, { 'demo-project': ['missing'] },
    { 'demo-project': ['demo-dev', 'demo-dev'] }, { 'demo-project': 'demo-dev' },
    JSON.parse('{"__proto__":[]}'),
  ])('rejects invalid selections atomically: %j', selection => {
    const target = demoWorkspace();
    const before = structuredClone(target);
    const bundle = detectImport(exportProject(fixture(), 'demo-project'));
    expect(() => importSelection(target, bundle, selection as never)).toThrow();
    expect(target).toEqual(before);
  });

  it.each([
    (w: Workspace) => { w.bindings[0].environmentId = 'missing'; },
    (w: Workspace) => { w.requests[0].environmentConfigs!['missing'] = w.requests[0].environmentConfigs!['demo-dev']; },
    (w: Workspace) => { w.services[0].projectId = 'missing'; },
    (w: Workspace) => { w.requests[0].id = w.projects[0].id; },
    (w: Workspace) => { w.projects.push({ ...w.projects[0] }); },
    (w: Workspace) => { w.folders[0].parentId = w.folders[0].id; },
  ])('validates preview and a mutated bundle again before import', mutate => {
    const w = fixture();
    mutate(w);
    expect(() => detectImport(native(w))).toThrow();
    const b = detectImport(native(fixture()));
    mutate(b.workspace);
    const target = demoWorkspace(), before = structuredClone(target);
    expect(() => importSelection(target, b, { 'demo-project': ['demo-dev'] })).toThrow();
    expect(target).toEqual(before);
  });

  it('rejects aggregate duplicate IDs, malicious keys, over-limit input without echoing secrets', () => {
    const w = fixture();
    w.projects.push({ id: 'p2', name: '第二项目', activeEnvironmentId: null });
    w.services.push({ id: w.environments[0].id, name: '重复', projectId: 'p2' });
    const bad = [
      native(w), '{"PRIVATE_SECRET":',
      native(fixture()).replace('"revision":8', '"__proto__":{"polluted":true},"revision":8'),
      JSON.stringify({ format: 'envdock-transfer', version: 99, workspace: fixture() }),
      ' '.repeat(10 * 1024 * 1024 + 1), '"' + '密'.repeat(4 * 1024 * 1024) + '"',
      '['.repeat(65) + '0' + ']'.repeat(65),
    ];
    for (const text of bad) {
      expect(() => detectImport(text)).toThrow();
      try { detectImport(text); } catch (error) { expect(String(error)).not.toContain('PRIVATE_SECRET'); }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('enforces the entity budget across projects', () => {
    const w = emptyWorkspace();
    for (let p = 0; p < 3; p++) {
      w.projects.push({ id: `p${p}`, name: '项目', activeEnvironmentId: null });
      for (let n = 0; n < 7000; n++) w.services.push({ id: `s${p}-${n}`, name: '服务', projectId: `p${p}` });
    }
    expect(() => detectImport(native(w))).toThrow(/上限|数量/);
  });

  it('copies local variant row IDs into a fresh global namespace', () => {
    const w = fixture();
    const config = w.requests[0].environmentConfigs!['demo-dev'];
    config.query.push({ id: w.projects[0].id, key: 'a', value: 'b', enabled: true });
    config.headers.push({ id: w.projects[0].id, key: 'Accept', value: 'application/json', enabled: true });
    config.form = [{ id: w.projects[0].id, key: 'f', value: 'v', kind: 'text', enabled: true }];
    const b = detectImport(exportSelection(w, { 'demo-project': ['demo-dev'] }));
    const next = importSelection(emptyWorkspace(), b, all(b.workspace));
    expect(next.requests[0].query[0].key).toBe('a');
    expect(next.requests[0].query[0].id).not.toBe(next.projects[0].id);
  });

  it('rejects duplicate IDs within one variant array atomically', () => {
    const w = fixture(), config = w.requests[0].environmentConfigs!['demo-dev'];
    config.query = [
      { id: 'same-row', key: 'a', value: 'one', enabled: true },
      { id: 'same-row', key: 'b', value: 'two', enabled: true },
    ];
    expect(() => detectImport(native(w))).toThrow(/重复 ID/);
    const bundle = detectImport(native(fixture()));
    bundle.workspace.requests[0].environmentConfigs!['demo-dev'] = config;
    const target = demoWorkspace(), before = structuredClone(target);
    expect(() => importSelection(target, bundle, { 'demo-project': ['demo-dev'] })).toThrow(/重复 ID/);
    expect(target).toEqual(before);
  });

  it('rejects a merged workspace exceeding the total entity budget atomically', () => {
    const source = demoWorkspace();
    source.requests[0].query = Array.from({ length: 9996 }, (_, n) => ({ id: `q${n}`, key: 'ordinary', value: '', enabled: true }));
    const bundle = detectImport(exportProject(source, 'demo-project'));
    const target = structuredClone(source), before = structuredClone(target);
    expect(() => importSelection(target, bundle, all(bundle.workspace))).toThrow(/上限|数量/);
    expect(target).toEqual(before);
  });

  it('rejects cross-project references and invalid unselected projects too', () => {
    const w = fixture();
    w.projects.push({ id: 'p2', name: '第二项目', activeEnvironmentId: null });
    w.environments.push({ id: 'foreign-env', projectId: 'p2', name: '外部环境', isProduction: false });
    w.bindings[0].environmentId = 'foreign-env';
    expect(() => exportSelection(w, { 'demo-project': [] })).toThrow();
    expect(() => detectImport(native(w))).toThrow();
  });

  it('handles empty projects and corrects a removed active environment on the final import', () => {
    const w = fixture();
    w.projects[0].activeEnvironmentId = 'demo-prod';
    const b = detectImport(native(w));
    const next = importSelection(emptyWorkspace(), b, { 'demo-project': ['demo-dev'] });
    expect(next.projects[0].activeEnvironmentId).toBe(next.environments[0].id);
    expect(next.requests[0].body).toBe('dev-only');
    expect(next.requests[0].environmentConfigs?.[next.environments[0].id].body).toBe('dev-only');
  });

  it('gives selected environments missing a variant an explicit neutral config', () => {
    const w = fixture();
    delete w.requests[0].environmentConfigs!['demo-dev'];
    const b = detectImport(exportSelection(w, { 'demo-project': ['demo-dev', 'demo-prod'] }));
    const r = b.workspace.requests[0];
    expect(r.body).toBe('');
    expect(r.environmentConfigs!['demo-dev'].body).toBe('');
    expect(r.environmentConfigs!['demo-prod'].body).toBe('prod-only');
  });

  it('accepts a UTF-8 BOM on legacy exchange files', () => {
    const b = detectImport('\uFEFF' + exportProject(demoWorkspace(), 'demo-project'));
    expect(b.workspace.requests).toHaveLength(2);
  });
});
