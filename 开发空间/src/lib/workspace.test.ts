import { describe, expect, it } from 'vitest';
import { cascadeDelete, emptyWorkspace, newRequest, responseForExecution, variableOwners } from './workspace';

describe('工作区关联与执行隔离', () => {
  it('删除服务清理目录、接口、绑定、关联变量，但保留其他服务', () => {
    const w = emptyWorkspace();
    w.services = [{ id: 's', projectId: 'p', name: '服务' }, { id: 'other', projectId: 'p', name: '保留' }];
    w.folders = [{ id: 'f', serviceId: 's', parentId: null, name: '目录' }];
    w.requests = [newRequest('s', 'f', 'r')];
    w.bindings = [{ id: 'b', projectId: 'p', environmentId: 'e', serviceId: 's', baseUrl: '', enabled: true }];
    w.variables = ['s', 'r', 'b'].map((ownerId, i) => ({ id: `${i}`, projectId: 'p', ownerId, scope: ['service', 'request', 'binding'][i] as 'service', name: 'token', value: '', isSecret: true }));
    const next = cascadeDelete(w, 'service', 's');
    expect(next.services.map(s => s.id)).toEqual(['other']);
    expect([next.folders, next.requests, next.bindings, next.variables]).toEqual([[], [], [], []]);
    expect(w.services).toHaveLength(2);
  });
  it('删除目录包含后代，且不删除兄弟目录', () => {
    const w = emptyWorkspace();
    w.folders = [
      { id: 'a', serviceId: 's', parentId: null, name: 'A' },
      { id: 'b', serviceId: 's', parentId: 'a', name: 'B' },
      { id: 'c', serviceId: 's', parentId: null, name: 'C' },
    ];
    w.requests = [newRequest('s', 'b', 'r')];
    expect(cascadeDelete(w, 'folder', 'a').folders.map(f => f.id)).toEqual(['c']);
    expect(cascadeDelete(w, 'folder', 'a').requests).toEqual([]);
  });
  it('变量来源顺序为项目、服务、环境、绑定、接口', () => {
    const w = emptyWorkspace();
    w.bindings = [{ id: 'b', projectId: 'p', serviceId: 's', environmentId: 'e', baseUrl: '', enabled: true }];
    expect(variableOwners(w, 'p', 'e', newRequest('s', null, 'r')).map(v => v.ownerId)).toEqual(['p', 's', 'e', 'b', 'r']);
  });
  it('其他执行 ID 的响应不能覆盖当前请求', () => {
    const response = { executionId: 'old' } as Parameters<typeof responseForExecution>[1];
    expect(responseForExecution('new', response)).toBeNull();
    expect(responseForExecution('old', response)).toBe(response);
  });
});
