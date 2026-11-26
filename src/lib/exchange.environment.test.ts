import { describe, expect, it, vi } from 'vitest';
import type { Pair, RequestConfig, Workspace } from '../types';
import { exportProject, importProject } from './exchange';
import { demoWorkspace, emptyWorkspace } from './workspace';

const pair = (id: string, key = 'page', value = '1'): Pair => ({ id, key, value, enabled: true });
const config = (): RequestConfig => ({
  query: [pair('demo-query')], headers: [pair('variant-header', 'Accept', 'application/json')],
  bodyType: 'json', body: '{"environment":"dev"}', timeoutMs: 12345,
});
const envelope = (project: Workspace, version = 2) => JSON.stringify({ format: 'api-workbench', version, project });
function fixture(): Workspace {
  const w: Workspace = demoWorkspace();
  w.projects[0].color = '#A1b2C3';
  w.environments[0].color = '#012345';
  w.environments[1].color = '#abcdef';
  w.requests[0].environmentConfigs = { 'demo-dev': config(), 'demo-prod': { ...config(), body: 'prod', timeoutMs: 9876 } };
  return w;
}
const variants = (w: Workspace) => w.requests[0].environmentConfigs!;
const variantPairs = (c: RequestConfig) => [...c.query, ...c.headers, ...(c.form ?? [])];
const allIds = (w: Workspace) => [
  ...w.projects, ...w.environments, ...w.services, ...w.bindings, ...w.folders, ...w.requests, ...w.variables,
  ...w.services.flatMap(s => s.headers ?? []),
  ...w.requests.flatMap(r => [...variantPairs(r), ...Object.values(r.environmentConfigs ?? {}).flatMap(variantPairs)]),
].map(e => e.id);

describe('环境配置交换兼容性', () => {
  it('保留颜色、各环境全部执行字段和基础缺省字段，版本升级为 2，不修改源数据', () => {
    const w = fixture();
    variants(w)['demo-dev'].auth = { kind: 'none' };
    variants(w)['demo-dev'].form = [{ ...pair('variant-form', 'caption', 'retained'), kind: 'text' }];
    const before = structuredClone(w);
    const result = JSON.parse(exportProject(w, w.projects[0].id));
    expect(result.version).toBe(2);
    expect(result.project).toEqual(w);
    expect(w).toEqual(before);
  });

  it.each(['project', 'environment', 'configs'] as const)('单独出现 %s 新字段也使用 v2，无新字段仍导出/导入 v1', field => {
    const w: Workspace = demoWorkspace();
    expect(JSON.parse(exportProject(w, w.projects[0].id)).version).toBe(1);
    expect(importProject(emptyWorkspace(), envelope(w, 1)).requests[0].body).toBe(w.requests[0].body);
    if (field === 'project') w.projects[0].color = '#123456';
    else if (field === 'environment') w.environments[0].color = '#abcdef';
    else w.requests[0].environmentConfigs = {};
    expect(JSON.parse(exportProject(w, w.projects[0].id)).version).toBe(2);
  });

  it('导入重映射环境键和全部 Pair，允许模板复制的跨基础/环境/数组重复 ID', () => {
    const source = fixture();
    // IDs only identify rows within a variant array, not across copied templates.
    variants(source)['demo-dev'].headers[0].id = 'demo-query';
    variants(source)['demo-dev'].form = [{ ...pair('demo-query', 'caption'), kind: 'text' }];
    const target = fixture();
    const before = structuredClone(target);
    const next = importProject(target, envelope(source)) as Workspace;
    const imported = next.requests[target.requests.length];
    const envs = next.environments.slice(target.environments.length);
    expect(Object.keys(imported.environmentConfigs!)).toEqual(envs.map(e => e.id));
    expect(imported.environmentConfigs![envs[0].id]).toMatchObject({
      body: '{"environment":"dev"}', timeoutMs: 12345, bodyType: 'json',
      query: [{ key: 'page', value: '1', enabled: true }],
    });
    expect(imported.environmentConfigs![envs[1].id]).toMatchObject({ body: 'prod', timeoutMs: 9876 });
    expect(imported.query[0].value).toBe('1');
    expect(imported.path).toBe('/users');
    expect(next.projects[1].color).toBe('#A1b2C3');
    expect(envs.map(e => e.color)).toEqual(['#012345', '#abcdef']);
    const roundtrip = JSON.parse(exportProject(next, next.projects[1].id)).project as Workspace;
    const importedIds = allIds(roundtrip);
    expect(new Set(importedIds).size).toBe(importedIds.length);
    expect(importedIds.some(id => allIds(source).includes(id) || allIds(target).includes(id))).toBe(false);
    expect(target).toEqual(before);
    expect(next.requests.slice(0, target.requests.length)).toEqual(before.requests);
  });

  it.each(['export', 'import'] as const)('%s 对每个环境脱敏鉴权、Header、Query、表单及同名覆盖变量，清除文件', operation => {
    const w = fixture();
    w.variables = [
      { id: 'var-dev', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'credentialRef', value: 'variable-dev-secret', isSecret: false },
      { id: 'var-prod', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-prod', name: 'credentialRef', value: 'variable-prod-secret', isSecret: false },
    ];
    for (const [env, c] of Object.entries(variants(w))) {
      c.auth = { kind: 'none', token: `${env}-token-secret`, username: `${env}-user-secret`, password: `${env}-pass-secret`, value: `${env}-value-secret` };
      c.headers.push(pair('secret-header', 'Authorization', 'Bearer {{credentialRef}}'), pair('cookie', 'Cookie', `${env}-cookie-secret`));
      c.query.push({ ...pair('secret-query', 'api_key', `${env}-query-secret`), enabled: false });
      c.form = [
        { ...pair('file', 'upload', `C:\\private\\${env}-private.txt`), kind: 'file' },
        { ...pair('secret-form', 'password', `${env}-form-secret`), kind: 'text' },
      ];
    }
    const before = structuredClone(w);
    const result = operation === 'export'
      ? JSON.parse(exportProject(w, w.projects[0].id)).project as Workspace
      : importProject(emptyWorkspace(), envelope(w)) as Workspace;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('-secret');
    expect(serialized).not.toContain('-private.txt');
    for (const c of Object.values(variants(result))) {
      expect(c.auth?.token).toMatch(/^\{\{exchange_secret_\d+\}\}$/);
      expect(c.headers.find(p => p.key === 'Authorization')?.value).toBe('Bearer {{credentialRef}}');
      expect(c.form?.[0]).toMatchObject({ value: '', enabled: false, kind: 'file' });
      expect(c.bodyType).toBe('json');
    }
    expect(result.variables.every(v => v.isSecret && v.value === '')).toBe(true);
    expect(result.variables.filter(v => v.scope === 'request').every(v => v.ownerId === result.requests[0].id)).toBe(true);
    expect(w).toEqual(before);
  });

  it('ID 分配避开目标环境 Pair 和源环境 Pair，复制模板的每一行获得新 ID', () => {
    const source = fixture(), target = fixture();
    variants(target)['demo-dev'].headers[0].id = 'occupied-variant-0000-0000-000000000000';
    variants(source)['demo-dev'].headers[0].id = 'source-variant-0000-0000-000000000000';
    let sequence = 0;
    const uuid = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('occupied-variant-0000-0000-000000000000')
      .mockReturnValueOnce('source-variant-0000-0000-000000000000')
      .mockImplementation(() => `fresh-0000-0000-0000-${++sequence}`);
    try {
      const next = importProject(target, envelope(source)) as Workspace;
      const imported = JSON.parse(exportProject(next, next.projects[1].id)).project as Workspace;
      expect(allIds(imported).every(id => id.startsWith('fresh-'))).toBe(true);
      expect(new Set(allIds(imported)).size).toBe(allIds(imported).length);
    } finally { uuid.mockRestore(); }
  });

  it.each([
    ['未知环境', (w: Workspace) => { w.requests[0].environmentConfigs = { missing: config() }; }, /环境.*引用/],
    ['服务 ID 不是环境', (w: Workspace) => { w.requests[0].environmentConfigs = { 'demo-users': config() }; }, /环境.*引用/],
    ['跨项目环境', (w: Workspace) => { w.environments[0].projectId = 'other-project'; }, /跨项目|绑定引用/],
    ['重复 Query ID', (w: Workspace) => { variants(w)['demo-dev'].query.push(pair('demo-query')); }, /重复 ID/],
    ['重复 Header ID', (w: Workspace) => { variants(w)['demo-dev'].headers.push(pair('variant-header')); }, /重复 ID/],
    ['重复 Form ID', (w: Workspace) => { variants(w)['demo-dev'].form = [0, 1].map(() => ({ ...pair('dup'), kind: 'text' })); }, /重复 ID/],
    ['基础全局重复 ID', (w: Workspace) => { w.requests[0].query[0].id = w.projects[0].id; }, /重复 ID/],
    ['无效超时', (w: Workspace) => { variants(w)['demo-dev'].timeoutMs = 300001; }, /超时/],
    ['无效正文类型', (w: Workspace) => { Object.assign(variants(w)['demo-dev'], { bodyType: 'binary' }); }, /正文类型/],
    ['无效鉴权', (w: Workspace) => { Object.assign(variants(w)['demo-dev'], { auth: { kind: 'apiKey', key: 'bad key', location: 'header' } }); }, /鉴权 Header/],
    ['无效表单', (w: Workspace) => { Object.assign(variants(w)['demo-dev'], { form: [{ ...pair('x'), kind: 'directory' }] }); }, /表单类型/],
    ['缺必要字段', (w: Workspace) => { delete (variants(w)['demo-dev'] as Partial<RequestConfig>).body; }, /缺少必要/],
    ['非配置对象', (w: Workspace) => { Object.assign(variants(w), { 'demo-dev': null }); }, /对象结构/],
    ['非映射对象', (w: Workspace) => { Object.assign(w.requests[0], { environmentConfigs: [] }); }, /对象结构/],
  ] as const)('拒绝%s，错误具体且导入/导出均不修改工作区', (_label, mutate, error) => {
    const w = fixture();
    mutate(w);
    const before = structuredClone(w);
    const target = demoWorkspace(), targetBefore = structuredClone(target);
    expect(() => importProject(target, envelope(w))).toThrow(error);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(error);
    expect(w).toEqual(before);
    expect(target).toEqual(targetBefore);
  });

  it.each(['id', 'path', 'name', 'method', 'serviceId', 'folderId', 'response', 'responses', 'environmentConfigs'])('配置拒绝共享/响应/嵌套字段 %s', field => {
    const w = fixture();
    Object.assign(variants(w)['demo-dev'], { [field]: 'private-response' });
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/未知或不安全字段/);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/未知或不安全字段/);
  });

  it.each(['__proto__', 'constructor', 'prototype', '', 'x'.repeat(257), 'bad\nid'])('拒绝不安全环境键 %#', key => {
    const w = fixture();
    w.environments[0].id = key;
    w.bindings[0].environmentId = key;
    w.requests[0].environmentConfigs = JSON.parse(JSON.stringify({ [key]: config() }));
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/不安全|ID|长度/);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/不安全|ID|长度/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(['red', '#abc', '#12345678', '#12345g', '#123456\n', '', null, 123])('拒绝非法项目/环境颜色 %s', color => {
    for (const owner of ['projects', 'environments'] as const) {
      const w = fixture();
      Object.assign(w[owner][0], { color });
      expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/颜色/);
      expect(() => exportProject(w, w.projects[0].id)).toThrow(/颜色/);
    }
  });

  it.each(['body', 'query', 'headers', 'auth', 'form'] as const)('环境 %s 字段沿用单字段长度限制', field => {
    const w = fixture(), c = variants(w)['demo-dev'], long = 'x'.repeat(2 * 1024 * 1024 + 1);
    if (field === 'body') c.body = long;
    else if (field === 'auth') c.auth = { kind: 'bearer', token: long };
    else if (field === 'form') c.form = [{ ...pair('form', 'file', long), kind: 'file' }];
    else c[field][0].value = long;
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/长度/);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/长度/);
  });

  it('环境 Pair 数组、环境映射数量都有上限', () => {
    const w = fixture();
    variants(w)['demo-dev'].query = Array.from({ length: 10001 }, (_, i) => pair(`q${i}`));
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/列表数量/);
    w.requests[0].environmentConfigs = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`e${i}`, config()]));
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/配置数量/);
  });

  it('总实体限制包含每个环境配置对象及其 Pair，而非按原始 ID 去重计数', () => {
    const w = fixture();
    // Demo has 9 top-level entities + 1 base pair. Two configs count as 2 more.
    variants(w)['demo-dev'] = { ...config(), headers: [], query: Array.from({ length: 10000 }, (_, i) => pair(`q${i}`)) };
    variants(w)['demo-prod'] = { ...config(), headers: [], query: Array.from({ length: 9988 }, (_, i) => pair(`q${i}`)) };
    expect(() => importProject(emptyWorkspace(), envelope(w))).not.toThrow(); // exactly 20,000
    variants(w)['demo-prod'].query.push(pair('last'));
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/实体数量/);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/实体数量/);
  });

  it('脱敏产生的秘密变量也计入实体总量', () => {
    const w = fixture();
    variants(w)['demo-dev'] = { ...config(), headers: [], query: Array.from({ length: 10000 }, (_, i) => pair(`q${i}`)) };
    variants(w)['demo-prod'] = { ...config(), headers: [], query: Array.from({ length: 9988 }, (_, i) => pair(`q${i}`)), auth: { kind: 'bearer', token: 'secret' } };
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/实体数量/);
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/实体数量/);
  });

  it('外部项目的环境不能进入导出配置，响应缓存不进入交换文件', () => {
    const w = fixture();
    Object.assign(w, { responses: { private: 'private-response' } });
    const text = exportProject(w, w.projects[0].id);
    expect(text).not.toContain('private-response');
    expect(text).not.toContain('responses');
    w.projects.push({ id: 'other', name: 'Other', activeEnvironmentId: null });
    w.environments.push({ id: 'other-env', projectId: 'other', name: 'Other', isProduction: false });
    variants(w)['other-env'] = config();
    expect(() => exportProject(w, w.projects[0].id)).toThrow(/环境.*引用/);
  });
});
