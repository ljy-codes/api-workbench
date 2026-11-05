import { describe, expect, it } from 'vitest';
import type { RequestHistoryEntry } from '../types';
import { demoWorkspace } from './workspace';
import { appendHistory, historyRequestSnapshot, restoreHistoryDraft } from './request-history';
import { resolveRequest } from './environment';

function entry(id = 'run'): RequestHistoryEntry {
  const workspace = demoWorkspace();
  return {
    id, projectId: 'demo-project', projectName: '项目', environmentId: 'demo-dev',
    environmentName: '开发', serviceName: '服务', startedAt: 100, finishedAt: 200,
    url: 'https://example.test/users', request: workspace.requests[0], temporaryVariables: [],
  };
}

describe('受限会话时间线', () => {
  it('快照仅包含提交的当前环境，后续编辑不能更改历史', () => {
    const request = demoWorkspace().requests[0];
    request.environmentConfigs = { other: { query: [], headers: [], bodyType: 'text', body: 'other-secret', timeoutMs: 1 } };
    const snapshot = historyRequestSnapshot(request);
    request.query[0].value = 'later';
    expect(snapshot.query[0].value).toBe('1');
    expect(snapshot.environmentConfigs).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('other-secret');
  });

  it('按完成顺序展示，去重执行 ID，并淘汰最早完成记录', () => {
    const first = appendHistory([], entry('a'), { maxEntries: 2, maxBytes: 100000 });
    const second = appendHistory(first, entry('b'), { maxEntries: 2, maxBytes: 100000 });
    const third = appendHistory(second, entry('c'), { maxEntries: 2, maxBytes: 100000 });
    expect(third.map(item => item.id)).toEqual(['c', 'b']);
    expect(appendHistory(third, { ...entry('b'), error: 'failed' }, { maxEntries: 2, maxBytes: 100000 }).map(item => item.id)).toEqual(['b', 'c']);
    expect(first.map(item => item.id)).toEqual(['a']);
  });

  it('按真实 UTF-8 序列化字节淘汰，单条超过容量则保留原历史', () => {
    const previous = [entry('old')];
    const huge = { ...entry('large'), error: '中文'.repeat(1000) };
    expect(appendHistory(previous, huge, { maxEntries: 50, maxBytes: 3000 })).toBe(previous);
    const small = entry('new');
    const bytes = new TextEncoder().encode(JSON.stringify(small)).byteLength;
    expect(appendHistory(previous, small, { maxEntries: 50, maxBytes: bytes + 2 }).map(item => item.id)).toEqual(['new']);
  });
});

describe('历史恢复只生成草稿', () => {
  it('恢复普通配置时沿用当前鉴权和敏感 Header / Query，不复活已移除的字面量秘密', () => {
    const workspace = demoWorkspace();
    const record = entry();
    record.request.auth = { kind: 'bearer', token: 'retired-bearer' };
    record.request.headers = [
      { id: 'cookie', key: 'Cookie', value: 'sid=retired-session', enabled: true },
      { id: 'gone', key: 'X-Api-Key', value: 'removed-secret', enabled: true },
      { id: 'content', key: 'Content-Type', value: 'application/json', enabled: true },
    ];
    record.request.query = [{ id: 'token', key: 'access_token', value: 'retired-query', enabled: true }];
    workspace.requests[0].environmentConfigs = {
      'demo-dev': { query: [{ id: 'token', key: 'access_token', value: 'current-query', enabled: true }],
        headers: [{ id: 'cookie', key: 'Cookie', value: 'sid=current-session', enabled: true }],
        auth: { kind: 'bearer', token: 'current-bearer' }, bodyType: 'none', body: '', timeoutMs: 30000 },
    };
    const restored = resolveRequest(restoreHistoryDraft(workspace, record).requests[0], 'demo-dev');
    expect(restored.auth?.token).toBe('current-bearer');
    expect(restored.headers.find(pair => pair.key === 'Cookie')?.value).toBe('sid=current-session');
    expect(restored.headers.find(pair => pair.key === 'Content-Type')?.value).toBe('application/json');
    expect(restored.query[0].value).toBe('current-query');
    expect(JSON.stringify(restored)).not.toMatch(/retired-|removed-secret/);
    expect(restored.headers.find(pair => pair.key === 'X-Api-Key')).toMatchObject({ value: '', enabled: false });
  });

  it('自定义 API Key 名称、动态键名和当前新增的凭据不会被历史覆盖或删除', () => {
    const workspace = demoWorkspace();
    const record = entry();
    record.request.auth = { kind: 'apiKey', key: 'x-custom', value: 'retired', location: 'query' };
    record.request.query = [{ id: 'custom', key: 'x-custom', value: 'retired', enabled: true }];
    record.request.headers = [{ id: 'dynamic', key: '{{headerName}}', value: 'retired', enabled: true }];
    workspace.requests[0].auth = { kind: 'none' };
    workspace.requests[0].query = [{ id: 'custom', key: 'x-custom', value: 'current', enabled: true }];
    workspace.requests[0].headers = [{ id: 'new', key: 'Authorization', value: 'Bearer current', enabled: true }];
    const restored = resolveRequest(restoreHistoryDraft(workspace, record).requests[0], 'demo-dev');
    expect(restored.auth).toEqual({ kind: 'none' });
    expect(restored.query[0].value).toBe('current');
    expect(restored.headers.find(pair => pair.key === 'Authorization')?.value).toBe('Bearer current');
    expect(JSON.stringify(restored)).not.toContain('retired');
  });

  it('回填原环境配置与共享方法路径，保留其他环境与当前请求名，文件需要重新选', () => {
    const workspace = demoWorkspace();
    const record = entry();
    record.request = { ...record.request, method: 'POST', path: '/historic', name: '旧名称', bodyType: 'multipart', body: '',
      form: [{ id: 'upload', key: 'upload', kind: 'file', value: 'C:\\private\\file.csv', enabled: true }],
      headers: [{ id: 'h', key: 'Authorization', value: '{{token}}', enabled: true }] };
    workspace.requests[0].environmentConfigs = {
      'demo-prod': { query: [], headers: [], bodyType: 'text', body: 'production-stays', timeoutMs: 1000 },
    };
    const restored = restoreHistoryDraft(workspace, record);
    expect(restored.projects[0].activeEnvironmentId).toBe('demo-dev');
    expect(restored.requests[0].name).toBe('获取用户列表');
    expect(restored.requests[0].path).toBe('/historic');
    expect(restored.requests[0].environmentConfigs?.['demo-dev'].headers[0].value).toBe('{{token}}');
    expect(restored.requests[0].environmentConfigs?.['demo-dev'].form?.[0]).toMatchObject({ value: '', enabled: false });
    expect(restored.requests[0].environmentConfigs?.['demo-prod'].body).toBe('production-stays');
    expect(workspace.requests[0].path).toBe('/users');
  });

  it('接口或环境已删除、服务关系发生变化时拒绝覆盖其他上下文', () => {
    for (const mutation of ['request', 'environment', 'service'] as const) {
      const workspace = demoWorkspace();
      if (mutation === 'request') workspace.requests = [];
      if (mutation === 'environment') workspace.environments = [];
      if (mutation === 'service') workspace.requests[0].serviceId = 'demo-orders';
      expect(() => restoreHistoryDraft(workspace, entry())).toThrow(/不存在|变化/);
    }
  });
});
