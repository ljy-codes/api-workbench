import { describe, expect, it } from 'vitest';
import { demoWorkspace } from './workspace';
import { cleanRequestBodies, resolveRequest, updateEnvironmentRequest } from './environment';
import { exportProject, importProject } from './exchange';
import { emptyWorkspace } from './workspace';

describe('环境独立执行配置', () => {
  it('多次编辑及清理后仍可直接导出导入，不写入 undefined 可选字段', () => {
    let w = demoWorkspace();
    w = updateEnvironmentRequest(w, 'demo-list', 'demo-dev', { body: 'first' });
    w = updateEnvironmentRequest(w, 'demo-list', 'demo-dev', { body: 'second' });
    let imported = importProject(emptyWorkspace(), exportProject(w, 'demo-project'));
    expect(Object.values(imported.requests[0].environmentConfigs!)[0].body).toBe('second');
    w = cleanRequestBodies(w);
    imported = importProject(emptyWorkspace(), exportProject(w, 'demo-project'));
    expect(Object.values(imported.requests[0].environmentConfigs!)[0].body).toBe('');
  });
  it('编辑 A 的正文/参数/鉴权不改变 B 或缺省模板，路径仍共用', () => {
    const w = demoWorkspace();
    const next = updateEnvironmentRequest(w, 'demo-list', 'demo-dev', {
      bodyType: 'json', body: '{"env":"A"}', path: '/shared',
      query: [{ id: 'a', key: 'q', value: 'A', enabled: true }],
      auth: { kind: 'bearer', token: '{{dev_token}}' },
    });
    const r = next.requests[0];
    expect(resolveRequest(r, 'demo-dev').body).toBe('{"env":"A"}');
    expect(resolveRequest(r, 'demo-prod').body).toBe('');
    expect(resolveRequest(r, 'demo-prod').auth).toBeUndefined();
    expect(resolveRequest(r, 'demo-prod').query[0].value).toBe('1');
    expect(resolveRequest(r, 'demo-prod').path).toBe('/shared');
    expect(r.body).toBe('');
    expect(w.requests[0].path).toBe('/users');
  });
  it('第一次覆盖为深拷贝且无环境不能编辑执行配置', () => {
    const w = demoWorkspace();
    const next = updateEnvironmentRequest(w, 'demo-list', 'demo-dev', { body: 'A' });
    next.requests[0].environmentConfigs!['demo-dev'].query[0].value = 'changed';
    expect(w.requests[0].query[0].value).toBe('1');
    expect(() => updateEnvironmentRequest(w, 'demo-list', null, { body: 'oops' })).toThrow('环境');
    expect(updateEnvironmentRequest(w, 'demo-list', null, { path: '/ok' }).requests[0].path).toBe('/ok');
    expect(() => updateEnvironmentRequest(w, 'demo-list', 'foreign', { body: 'oops' })).toThrow('环境');
  });
  it('清理仅清正文和表单值/文件，保留结构及其他配置', () => {
    let w = demoWorkspace();
    w = updateEnvironmentRequest(w, 'demo-create', 'demo-dev', {
      body: 'private', form: [{ id: 'f', key: 'file', kind: 'file', value: 'C:\\private.txt', enabled: true }],
      headers: [{ id: 'h', key: 'X-Mode', value: 'test', enabled: true }],
    });
    const clean = cleanRequestBodies(w);
    const r = clean.requests[1];
    expect(r.body).toBe('');
    expect(r.bodyType).toBe('json');
    expect(r.environmentConfigs!['demo-dev'].body).toBe('');
    expect(r.environmentConfigs!['demo-dev'].form?.[0]).toMatchObject({ key: 'file', value: '', enabled: false });
    expect(r.environmentConfigs!['demo-dev'].headers[0].value).toBe('test');
    expect(r.path).toBe('/users');
    expect(clean.bindings).toEqual(w.bindings);
    expect(w.requests[1].environmentConfigs!['demo-dev'].body).toBe('private');
  });
});
