import { describe, expect, it } from 'vitest';
import type { Pair, Workspace } from '../types';
import { exportProject, importProject } from './exchange';
import { demoWorkspace, emptyWorkspace } from './workspace';

const pair = (id: string, key: string, value: string): Pair => ({ id, key, value, enabled: true });
const envelope = (project: Workspace) => JSON.stringify({ format: 'api-workbench', version: 1, project });
function fixture(): Workspace {
  const w = demoWorkspace();
  w.revision = 17;
  w.services[0].headers = [pair('sh', 'X-API-Key', 'header-secret')];
  w.services[0].auth = { kind: 'bearer', token: 'auth-secret' };
  const r = w.requests[0];
  r.headers = [pair('cookie', 'Cookie', 'session=cookie-secret; theme=dark'), pair('safe', 'Accept', 'application/json')];
  r.query.push(pair('secret-q', 'access_token', 'query-secret'));
  r.auth = { kind: 'basic', username: 'private-user', password: 'password-secret' };
  r.form = [{ id: 'file', key: 'upload', value: 'C:\\private\\secret.txt', enabled: true, kind: 'file' }];
  w.folders.push({ id: 'child', serviceId: w.services[0].id, parentId: w.folders[0].id, name: '子目录' });
  r.folderId = 'child';
  w.variables = [
    { id: 'vp', projectId: w.projects[0].id, scope: 'project', ownerId: w.projects[0].id, name: 'plain', value: 'retained', isSecret: false },
    { id: 'vs', projectId: w.projects[0].id, scope: 'service', ownerId: w.services[0].id, name: 'service_secret', value: 'variable-secret', isSecret: true },
    { id: 've', projectId: w.projects[0].id, scope: 'environment', ownerId: w.environments[0].id, name: 'env', value: 'dev', isSecret: false },
    { id: 'vb', projectId: w.projects[0].id, scope: 'binding', ownerId: w.bindings[0].id, name: 'binding', value: 'v', isSecret: false },
    { id: 'vr', projectId: w.projects[0].id, scope: 'request', ownerId: r.id, name: 'request', value: 'v', isSecret: false },
  ];
  return w;
}
function ids(w: Workspace): string[] {
  return [
    ...w.projects, ...w.environments, ...w.services, ...w.bindings, ...w.folders, ...w.requests, ...w.variables,
    ...w.services.flatMap(s => s.headers ?? []),
    ...w.requests.flatMap(r => [...r.headers, ...r.query, ...(r.form ?? [])]),
  ].map(x => x.id);
}

describe('单项目交换纯函数', () => {
  it('仅导出一个项目，清理秘密和文件但保留非敏感内容，不修改原工作区', () => {
    const w = fixture();
    w.projects.push({ id: 'other', name: '其他项目', activeEnvironmentId: null });
    w.services.push({ id: 'other-s', projectId: 'other', name: '其他服务' });
    const before = structuredClone(w);
    const text = exportProject(w, w.projects[0].id);
    const result = JSON.parse(text);
    expect(result.format).toBe('api-workbench');
    expect(result.version).toBe(1);
    expect(result.project.projects).toHaveLength(1);
    expect(result.project.services).toHaveLength(2);
    for (const secret of ['header-secret', 'auth-secret', 'cookie-secret', 'query-secret', 'private-user', 'password-secret', 'variable-secret', 'secret.txt']) {
      expect(text).not.toContain(secret);
    }
    expect(result.project.requests[0].form[0]).toMatchObject({ value: '', enabled: false });
    expect(result.project.variables.filter((v: { isSecret: boolean }) => v.isSecret).every((v: { value: string }) => v.value === '')).toBe(true);
    expect(text).toContain('retained');
    expect(w).toEqual(before);
  });

  it('重映射全部实体/Pair/Form ID 和所有引用，保留目标 revision 和无关项目', () => {
    const source = fixture();
    const target = fixture();
    const before = structuredClone(target);
    const next = importProject(target, exportProject(source, source.projects[0].id));
    const p = next.projects[1];
    expect(next.revision).toBe(17);
    expect(next.activeProjectId).toBe(p.id);
    expect(p.name).toBe(`${source.projects[0].name} (2)`);
    expect(p.activeEnvironmentId).toBe(next.environments[2].id);
    expect(next.services[2].projectId).toBe(p.id);
    expect(next.bindings[1]).toMatchObject({ projectId: p.id, serviceId: next.services[2].id, environmentId: next.environments[2].id });
    expect(next.folders[2]).toMatchObject({ serviceId: next.services[2].id, parentId: null });
    expect(next.folders[3].parentId).toBe(next.folders[2].id);
    expect(next.requests[2]).toMatchObject({ serviceId: next.services[2].id, folderId: next.folders[3].id });
    const ownerIds = [p.id, next.services[2].id, next.environments[2].id, next.bindings[1].id, next.requests[2].id];
    expect(next.variables.slice(target.variables.length, target.variables.length + 5).map(v => v.ownerId)).toEqual(ownerIds);
    expect(new Set(ids(next)).size).toBe(ids(next).length);
    const original = new Set(ids(source));
    const imported = JSON.parse(exportProject(next, p.id)).project as Workspace;
    expect(ids(imported).some(id => original.has(id))).toBe(false);
    expect(next.projects[0]).toEqual(before.projects[0]);
    expect(next.requests.slice(0, 2)).toEqual(before.requests);
    expect(target).toEqual(before);
  });

  it('重新计算失效活动选择，名称递增，无环境时使用 null', () => {
    const source = demoWorkspace();
    source.activeProjectId = 'stale';
    source.projects[0].activeEnvironmentId = 'stale';
    const target = demoWorkspace();
    target.projects.push({ id: 'collision', name: `${target.projects[0].name} (2)`, activeEnvironmentId: null });
    const next = importProject(target, envelope(source));
    expect(next.projects[2].name).toBe(`${source.projects[0].name} (3)`);
    expect(next.projects[2].activeEnvironmentId).toBe(next.environments[2].id);
    const bare = emptyWorkspace();
    bare.projects.push({ id: 'p', name: '空项目', activeEnvironmentId: null });
    expect(importProject(emptyWorkspace(), envelope(bare)).projects[0].activeEnvironmentId).toBeNull();
  });

  it('将凭据引用指向的非秘密变量及同名覆盖变量也脱敏，保留安全引用', () => {
    const w = fixture();
    w.services[0].headers = [pair('h', 'Authorization', 'Bearer {{plain}}')];
    w.services[0].auth = { kind: 'bearer', token: '{{ plain }}' };
    w.variables.push({ ...w.variables[0], id: 'shadow', scope: 'environment', ownerId: w.environments[0].id, value: 'shadow-secret' });
    const exported = JSON.parse(exportProject(w, w.projects[0].id)).project as Workspace;
    expect(exported.services[0].headers?.[0].value).toBe('Bearer {{plain}}');
    expect(exported.variables.filter(v => v.name === 'plain').every(v => v.isSecret && v.value === '')).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('shadow-secret');
  });

  it('外部文件中明文鉴权、Header/Query 和秘密变量也不能绕过脱敏', () => {
    const next = importProject(emptyWorkspace(), envelope(fixture()));
    const serialized = JSON.stringify(next);
    expect(serialized).not.toContain('password-secret');
    expect(serialized).not.toContain('query-secret');
    expect(next.variables.filter(v => v.isSecret).every(v => v.value === '')).toBe(true);
  });

  it('复合凭据被替换后，其引用变量也必须清空；普通正文保留供人工检查', () => {
    const w = fixture();
    w.services[0].headers = [pair('h', 'Authorization', 'Bearer prefix-{{plain}}-suffix')];
    w.requests[0].body = '{"privateBusinessData":"body-kept-for-review"}';
    const text = exportProject(w, w.projects[0].id);
    expect(text).not.toContain('retained');
    expect(text).toContain('body-kept-for-review');
    expect(JSON.parse(text).project.variables.find((v: { name: string }) => v.name === 'plain')).toMatchObject({ value: '', isSecret: true });
  });

  it('兼容无新增可选字段的旧 DTO 和 Rust 非 apiKey 鉴权的空 location', () => {
    const source = demoWorkspace();
    source.services[0].auth = JSON.parse('{"kind":"bearer","token":"{{secret}}","username":"","password":"","key":"","value":"","location":""}');
    const next = importProject(emptyWorkspace(), envelope(source));
    expect(next.services[0].auth).not.toHaveProperty('location');
    expect(next.requests[0].form).toBeUndefined();
  });

  it('不将 ID 字符串值当作对象属性，__proto__ ID 也可完整重映射', () => {
    const w = emptyWorkspace();
    w.activeProjectId = '__proto__';
    w.projects = [{ id: '__proto__', name: '安全 Map', activeEnvironmentId: null }];
    const next = importProject(emptyWorkspace(), envelope(w));
    expect(next.projects[0].id).not.toBe('__proto__');
    expect(next.activeProjectId).toBe(next.projects[0].id);
  });

  it('限制单字段长度、UTF-8 字节数和目录链深度，不泄漏错误详情', () => {
    const w = demoWorkspace();
    w.requests[0].body = 'a'.repeat(2 * 1024 * 1024 + 1);
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/长度|上限/);
    expect(() => importProject(emptyWorkspace(), '"' + '密'.repeat(4 * 1024 * 1024) + '"')).toThrow(/大小|上限/);
    const nested = demoWorkspace();
    for (let i = 0; i < 33; i++) nested.folders.push({ id: `nested-${i}`, serviceId: nested.services[0].id, parentId: i ? `nested-${i - 1}` : null, name: '目录' });
    expect(() => importProject(emptyWorkspace(), envelope(nested))).toThrow(/嵌套/);
  });

  it('空白变量引用不是合法鉴权模板，替换为可填写秘密引用', () => {
    const w = demoWorkspace();
    w.services[0].auth = { kind: 'bearer', token: '{{     }}' };
    const next = importProject(emptyWorkspace(), envelope(w));
    expect(next.services[0].auth?.token).not.toBe('{{     }}');
    expect(next.variables).toEqual([expect.objectContaining({ isSecret: true, value: '', scope: 'service', ownerId: next.services[0].id })]);
  });

  it('达到名称长度上限的重名项目仍能加后缀导入', () => {
    const source = demoWorkspace();
    source.projects[0].name = '项'.repeat(1024);
    const target = structuredClone(source);
    const next = importProject(target, envelope(source));
    expect(next.projects[1].name.length).toBeLessThanOrEqual(1024);
    expect(next.projects[1].name).toMatch(/ \(2\)$/);
  });

  it.each([
    ['多项目', (w: Workspace) => w.projects.push({ id: 'p2', name: '非法', activeEnvironmentId: null })],
    ['空项目', (w: Workspace) => { w.projects = []; }],
    ['跨项目服务', (w: Workspace) => { w.services[0].projectId = 'missing'; }],
    ['未知环境', (w: Workspace) => { w.bindings[0].environmentId = 'missing'; }],
    ['跨服务目录', (w: Workspace) => { w.requests[0].serviceId = w.services[1].id; }],
    ['目录环', (w: Workspace) => { w.folders[0].parentId = 'child'; }],
    ['重复 ID', (w: Workspace) => { w.requests[0].headers[0].id = w.projects[0].id; }],
    ['未知变量 owner', (w: Workspace) => { w.variables[0].ownerId = 'missing'; }],
    ['重复绑定', (w: Workspace) => w.bindings.push({ ...w.bindings[0], id: 'b2' })],
    ['重复变量', (w: Workspace) => w.variables.push({ ...w.variables[0], id: 'v2' })],
    ['无效 timeout', (w: Workspace) => { w.requests[0].timeoutMs = -1; }],
    ['无效 scope', (w: Workspace) => { (w.variables[0] as unknown as { scope: string }).scope = 'constructor'; }],
    ['错误布尔', (w: Workspace) => { (w.requests[0].headers[0] as unknown as { enabled: string }).enabled = 'true'; }],
    ['未知字段', (w: Workspace) => { Object.assign(w.requests[0], { injected: 'x' }); }],
  ])('拒绝%s，不污染目标', (_label, mutate) => {
    const w = fixture();
    mutate(w);
    const target = demoWorkspace();
    const before = structuredClone(target);
    expect(() => importProject(target, envelope(w))).toThrow(/[项目目录引用变量绑定字段结构类型超时ID]/);
    expect(target).toEqual(before);
  });

  it('拒绝畸形 JSON、版本、原型属性、过深/超量/超大输入；错误不回显内容', () => {
    for (const text of [
      '{"private-secret":',
      JSON.stringify({ format: 'api-workbench', version: 2, project: fixture() }),
      envelope(fixture()).replace('"revision":17', '"__proto__":{"polluted":true},"revision":17'),
      envelope(fixture()).replace('"revision":17', '"constructor":{},"revision":17'),
      '['.repeat(100) + '0' + ']'.repeat(100),
      ' '.repeat(10 * 1024 * 1024 + 1),
    ]) {
      expect(() => importProject(emptyWorkspace(), text)).toThrow();
      try { importProject(emptyWorkspace(), text); } catch (e) { expect(String(e)).not.toContain('private-secret'); }
    }
    const w = fixture();
    w.requests[0].query = Array.from({ length: 20001 }, (_, i) => pair(`huge-${i}`, 'a', 'b'));
    expect(() => importProject(emptyWorkspace(), envelope(w))).toThrow(/数量|上限/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('未知项目不能导出', () => {
    expect(() => exportProject(demoWorkspace(), 'missing')).toThrow(/项目/);
  });
});
