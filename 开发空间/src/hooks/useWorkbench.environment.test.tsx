import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Preview, ResponseData, Workspace } from '../types';
import { demoWorkspace } from '../lib/workspace';
import { api } from '../lib/ipc';
import { useWorkbench } from './useWorkbench';

vi.mock('../lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  loadResponse: vi.fn(), saveResponse: vi.fn(), clearResponse: vi.fn(), clearResponses: vi.fn(), compactStorage: vi.fn(),
} }));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const response = (id: string, body = 'A'): ResponseData => ({
  executionId: id, body, status: 200, statusText: 'OK', durationMs: 1, sizeBytes: body.length, headers: [],
  truncated: false, environmentName: '开发环境', url: 'https://example.com',
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.save).mockImplementation(async w => ({ ...w, revision: w.revision + 1 }));
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.saveResponse).mockResolvedValue(undefined);
  vi.mocked(api.clearResponse).mockResolvedValue(undefined);
  vi.mocked(api.clearResponses).mockResolvedValue(undefined);
  vi.mocked(api.compactStorage).mockResolvedValue(undefined);
  vi.mocked(api.preview).mockResolvedValue({ url: 'https://example.com', environmentName: '开发环境', serviceName: 's', isProduction: false, resolvedVariables: [] });
});
afterEach(cleanup);
async function setup() {
  const hook = renderHook(useWorkbench);
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}
describe('工作区加载互斥', () => {
  it('初始化 effect 在 StrictMode 下只读取一次，读取期间阻止修改和重复加载', async () => {
    const pending = deferred<Workspace>();
    vi.mocked(api.load).mockReturnValue(pending.promise);
    const { result } = renderHook(useWorkbench, { wrapper: StrictMode });
    const initialBusy = result.current.busy;
    act(() => {
      result.current.mutate(w => ({ ...w, revision: 99 }));
      void result.current.load();
    });
    const pendingRevision = result.current.workspace.revision;
    await act(async () => { pending.resolve(demoWorkspace()); });
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(initialBusy).toBe(true);
    expect(pendingRevision).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.request?.id).toBe('demo-list');
    act(() => result.current.updateRequest({ body: 'after-initial-load' }));
    expect(result.current.request?.body).toBe('after-initial-load');
    expect(api.load).toHaveBeenCalledTimes(1);
  });
  it('有草稿时拒绝重载，即使调用的是修改前的 load 回调', async () => {
    const { result } = await setup();
    const reload = result.current.load;
    await act(async () => {
      result.current.updateRequest({ body: 'keep-draft' });
      await reload();
    });
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(result.current.request?.body).toBe('keep-draft');
    expect(result.current.selectedId).toBe('demo-list');
    expect(result.current.environment?.id).toBe('demo-dev');
    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toContain('未保存');
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(false);
  });
  it.each(['成功', '失败'] as const)('重载%s：读取期间持锁，阻止编辑、重复加载、切换及清理，结束后释放', async outcome => {
    const { result } = await setup();
    const pending = deferred<Workspace>();
    vi.mocked(api.load).mockReturnValue(pending.promise);
    const before = result.current.workspace;
    let reloading!: Promise<void>;
    act(() => {
      reloading = result.current.load();
      void result.current.load();
      result.current.updateRequest({ body: 'must-not-apply' });
      result.current.mutate(w => ({ ...w, revision: 99 }));
      result.current.setTemporary([{ id: 't', key: 'key', value: 'must-not-apply', enabled: true }]);
    });
    const pendingBusy = result.current.busy;
    const pendingWorkspace = result.current.workspace;
    const pendingTemporary = result.current.temporary;
    let cleaned!: boolean;
    await act(async () => {
      await result.current.selectEnvironment('demo-prod');
      await result.current.closeTab('demo-list');
      cleaned = await result.current.cleanData(false);
    });
    const pendingEnvironment = result.current.environment?.id;
    const pendingSelection = result.current.selectedId;
    await act(async () => {
      if (outcome === '成功') pending.resolve({ ...demoWorkspace(), revision: 7 });
      else pending.reject(new Error('读取失败'));
      await reloading;
    });
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(pendingBusy).toBe(true);
    expect(pendingWorkspace).toBe(before);
    expect(pendingTemporary).toEqual([]);
    expect(pendingEnvironment).toBe('demo-dev');
    expect(pendingSelection).toBe('demo-list');
    expect(cleaned).toBe(false);
    expect(api.clearResponses).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.dirty).toBe(false);
    if (outcome === '成功') expect(result.current.workspace.revision).toBe(7);
    else {
      expect(result.current.workspace).toBe(before);
      expect(result.current.notice).toContain('读取失败');
    }
    act(() => result.current.updateRequest({ body: 'after-load' }));
    expect(result.current.request?.body).toBe('after-load');
    expect(result.current.dirty).toBe(true);
  });
  it('请求准备期间拒绝重载，不释放准备锁', async () => {
    const { result } = await setup();
    const pending = deferred<Preview>();
    vi.mocked(api.preview).mockReturnValueOnce(pending.promise);
    let preparing!: Promise<void>;
    act(() => { preparing = result.current.execute(true); });
    await act(async () => { await result.current.load(); });
    const stillBusy = result.current.busy;
    act(() => result.current.updateRequest({ body: 'must-not-apply' }));
    await act(async () => {
      pending.resolve({ url: 'https://example.com', environmentName: '开发环境', serviceName: 's', isProduction: false, resolvedVariables: [] });
      await preparing;
    });
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(stillBusy).toBe(true);
    expect(result.current.request?.body).toBe('');
    expect(result.current.busy).toBe(false);
    expect(result.current.preview?.url).toBe('https://example.com');
  });
  it('保存期间拒绝重载，不覆盖保存快照或提前解锁', async () => {
    const { result } = await setup();
    const pending = deferred<Workspace>();
    vi.mocked(api.save).mockReturnValueOnce(pending.promise);
    act(() => result.current.updateRequest({ body: 'saving-draft' }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(); });
    const snapshot = vi.mocked(api.save).mock.calls[0][0];
    await act(async () => { await result.current.load(); });
    const pendingBody = result.current.request?.body;
    const pendingBusy = result.current.busy;
    await act(async () => { pending.resolve({ ...snapshot, revision: 1 }); await saving; });
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(pendingBody).toBe('saving-draft');
    expect(pendingBusy).toBe(true);
    expect(result.current.request?.body).toBe('saving-draft');
    expect(result.current.dirty).toBe(false);
    expect(result.current.busy).toBe(false);
  });
  it('网络运行期间拒绝重载，保留取消能力和最终响应', async () => {
    const { result } = await setup();
    const pending = deferred<ResponseData>();
    vi.mocked(api.send).mockReturnValueOnce(pending.promise);
    let sending!: Promise<void>;
    act(() => { sending = result.current.execute(); });
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    const id = vi.mocked(api.send).mock.calls[0][0].executionId;
    await act(async () => { await result.current.load(); });
    const stillRunning = result.current.hasRunning;
    await act(async () => { await result.current.cancel(); });
    await act(async () => { pending.resolve(response(id)); await sending; });
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(stillRunning).toBe(true);
    expect(api.cancel).toHaveBeenCalledWith(id);
    expect(result.current.execution?.response?.executionId).toBe(id);
    expect(result.current.hasRunning).toBe(false);
    expect(api.saveResponse).toHaveBeenCalledWith('demo-list', 'demo-dev', expect.objectContaining({ executionId: id }));
  });
  it('响应落盘期间仍拒绝重载，落盘后才允许重读最近响应', async () => {
    const { result } = await setup();
    const pending = deferred<void>();
    vi.mocked(api.send).mockImplementation(async input => response(input.executionId));
    vi.mocked(api.saveResponse).mockReturnValueOnce(pending.promise);
    let sending!: Promise<void>;
    act(() => { sending = result.current.execute(); });
    await waitFor(() => expect(api.saveResponse).toHaveBeenCalledOnce());
    const savedResponse = vi.mocked(api.saveResponse).mock.calls[0][2];
    await act(async () => { await result.current.load(); });
    const callsWhileSaving = vi.mocked(api.load).mock.calls.length;
    const visibleWhileSaving = result.current.execution?.response;
    await act(async () => { pending.resolve(); await sending; });
    expect(callsWhileSaving).toBe(1);
    expect(visibleWhileSaving).toEqual(savedResponse);
    vi.mocked(api.loadResponse).mockResolvedValue(savedResponse);
    await act(async () => { await result.current.load(); });
    expect(api.load).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.execution?.response).toEqual(savedResponse));
  });
  it('初始化读取失败后释放锁，允许重试且不会重新运行初始化 effect', async () => {
    vi.mocked(api.load).mockRejectedValueOnce(new Error('初次读取失败'));
    const { result } = await setup();
    expect(result.current.notice).toContain('初次读取失败');
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.load(); });
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.request?.id).toBe('demo-list');
  });
});
describe('环境隔离和静默自动保存', () => {
  it('切换环境先保存 A 草稿，共享路径但 B 正文独立，无确认弹窗', async () => {
    const { result } = await setup();
    act(() => result.current.updateRequest({ body: 'A', path: '/shared' }));
    await act(async () => result.current.selectEnvironment('demo-prod'));
    expect(result.current.environment?.id).toBe('demo-prod');
    expect(result.current.request?.body).toBe('');
    expect(result.current.request?.path).toBe('/shared');
    expect(result.current.dirty).toBe(false);
    expect(result.current.confirmation).toBeNull();
    expect(vi.mocked(api.save).mock.calls[0][0].requests[0].environmentConfigs?.['demo-dev'].body).toBe('A');
    act(() => result.current.updateRequest({ body: 'B' }));
    await act(async () => result.current.selectEnvironment('demo-dev'));
    expect(result.current.request?.body).toBe('A');
  });
  it('保存失败保留旧环境和草稿，不继续发送', async () => {
    const { result } = await setup();
    act(() => result.current.updateRequest({ body: 'draft' }));
    vi.mocked(api.save).mockRejectedValue(new Error('磁盘已满'));
    await act(async () => result.current.selectEnvironment('demo-prod'));
    expect(result.current.environment?.id).toBe('demo-dev');
    expect(result.current.request?.body).toBe('draft');
    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toContain('磁盘已满');
    await act(async () => result.current.execute());
    expect(api.send).not.toHaveBeenCalled();
    expect(result.current.confirmation).toBeNull();
  });
  it('保存等待期间禁止重复保存和切换，不会覆盖后续草稿', async () => {
    const { result } = await setup();
    const pending = deferred<Workspace>();
    vi.mocked(api.save).mockReturnValueOnce(pending.promise);
    act(() => result.current.updateRequest({ body: 'before' }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(); });
    act(() => { result.current.updateRequest({ body: 'ignored-disabled' }); void result.current.save(); void result.current.selectEnvironment('demo-prod'); });
    expect(api.save).toHaveBeenCalledTimes(1);
    const snapshot = vi.mocked(api.save).mock.calls[0][0];
    await act(async () => { pending.resolve({ ...snapshot, revision: 1 }); await saving; });
    expect(result.current.request?.body).toBe('before');
    act(() => result.current.updateRequest({ body: 'after' }));
    expect(result.current.request?.body).toBe('after');
    expect(result.current.dirty).toBe(true);
  });
  it('切换接口和关闭当前标签自动保存，失败时不关闭', async () => {
    const { result } = await setup();
    act(() => result.current.updateRequest({ body: 'A' }));
    await act(async () => result.current.selectRequest('demo-create'));
    expect(result.current.selectedId).toBe('demo-create');
    expect(api.save).toHaveBeenCalledTimes(1);
    act(() => result.current.updateRequest({ body: 'B' }));
    vi.mocked(api.save).mockRejectedValueOnce(new Error('失败'));
    await act(async () => result.current.closeTab('demo-create'));
    expect(result.current.selectedId).toBe('demo-create');
    expect(result.current.openTabs).toContain('demo-create');
  });
  it('A 的迟到响应只归属 A，B 不显示，切回 A 可见且按环境持久化', async () => {
    const { result } = await setup();
    const pending = deferred<ResponseData>();
    vi.mocked(api.send).mockReturnValueOnce(pending.promise);
    let sending!: Promise<void>;
    act(() => { sending = result.current.execute(); });
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    const id = vi.mocked(api.send).mock.calls[0][0].executionId;
    await act(async () => result.current.selectEnvironment('demo-prod'));
    expect(result.current.execution).toBeUndefined();
    await act(async () => { pending.resolve(response(id)); await sending; });
    expect(result.current.execution).toBeUndefined();
    expect(api.saveResponse).toHaveBeenCalledWith('demo-list', 'demo-dev', expect.objectContaining({ body: 'A' }));
    await act(async () => result.current.selectEnvironment('demo-dev'));
    expect(result.current.execution?.response?.body).toBe('A');
  });
  it('旧缓存迟到不覆盖刚发送的新响应', async () => {
    const old = deferred<ResponseData | null>();
    vi.mocked(api.loadResponse).mockReturnValueOnce(old.promise);
    const { result } = await setup();
    vi.mocked(api.send).mockImplementation(async input => response(input.executionId, 'new'));
    await act(async () => result.current.execute());
    await act(async () => old.resolve(response('old', 'old')));
    expect(result.current.execution?.response?.body).toBe('new');
  });
  it('重开读取缓存，清除后不再显示；持久化失败仍保留当次可见响应并提示', async () => {
    vi.mocked(api.loadResponse).mockResolvedValueOnce(response('cached'));
    const { result } = await setup();
    await waitFor(() => expect(result.current.execution?.response?.body).toBe('A'));
    await act(async () => result.current.clearResponse());
    expect(api.clearResponse).toHaveBeenCalledWith('demo-list', 'demo-dev');
    expect(result.current.execution).toBeUndefined();
    vi.mocked(api.send).mockImplementation(async input => response(input.executionId, 'visible'));
    vi.mocked(api.saveResponse).mockRejectedValueOnce(new Error('写盘失败'));
    await act(async () => result.current.execute());
    expect(result.current.execution?.response?.body).toBe('visible');
    expect(result.current.notice).toContain('写盘失败');
  });
  it('全局清理可选清正文，保留接口和参数并压缩；运行期间拒绝清理', async () => {
    const { result } = await setup();
    act(() => result.current.updateRequest({ body: 'draft' }));
    await act(async () => { expect(await result.current.cleanData(true)).toBe(true); });
    expect(result.current.request?.body).toBe('');
    expect(result.current.workspace.requests).toHaveLength(2);
    expect(result.current.request?.query[0].value).toBe('1');
    expect(api.clearResponses).toHaveBeenCalledOnce();
    expect(api.compactStorage).toHaveBeenCalledOnce();
    const pending = deferred<ResponseData>();
    vi.mocked(api.send).mockReturnValue(pending.promise);
    let sending!: Promise<void>;
    act(() => { sending = result.current.execute(); });
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    await act(async () => { expect(await result.current.cleanData(true)).toBe(false); });
    expect(api.clearResponses).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(response(vi.mocked(api.send).mock.calls[0][0].executionId)); await sending; });
  });
  it('默认清响应不修改未保存请求草稿、临时变量或接口定义', async () => {
    const { result } = await setup();
    act(() => {
      result.current.updateRequest({ body: 'keep-draft' });
      result.current.setTemporary([{ id: 't', key: 'key', value: 'keep', enabled: true }]);
    });
    await act(async () => { expect(await result.current.cleanData(false)).toBe(true); });
    expect(result.current.dirty).toBe(true);
    expect(result.current.request?.body).toBe('keep-draft');
    expect(result.current.temporary[0]?.value).toBe('keep');
    expect(api.save).not.toHaveBeenCalled();
  });
  it('同接口同环境重新加载也恢复最近响应', async () => {
    vi.mocked(api.loadResponse).mockResolvedValue(response('cached'));
    const { result } = await setup();
    await waitFor(() => expect(result.current.execution?.response?.executionId).toBe('cached'));
    await act(async () => result.current.load());
    await waitFor(() => expect(result.current.execution?.response?.executionId).toBe('cached'));
    expect(api.loadResponse).toHaveBeenCalledTimes(2);
  });
  it('正文清理成功而响应清理失败时明确说明部分完成，不假装回滚', async () => {
    const { result } = await setup();
    act(() => result.current.updateRequest({ body: 'will-clear' }));
    vi.mocked(api.clearResponses).mockRejectedValueOnce(new Error('SQLite busy'));
    await act(async () => { expect(await result.current.cleanData(true)).toBe(false); });
    expect(result.current.request?.body).toBe('');
    expect(result.current.dirty).toBe(false);
    expect(result.current.notice).toContain('请求正文和表单已清空');
    expect(result.current.notice).toContain('响应缓存清理失败');
    expect(api.compactStorage).not.toHaveBeenCalled();
  });
});
