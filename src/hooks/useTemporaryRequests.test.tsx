import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import type { ResponseData, TemporaryExecuteInput } from '../types';
import { useTemporaryRequests } from './useTemporaryRequests';

vi.mock('../lib/ipc', () => ({
  desktop: true,
  api: {
    previewTemporary: vi.fn(), sendTemporary: vi.fn(), cancel: vi.fn(),
    save: vi.fn(), saveResponse: vi.fn(), loadResponse: vi.fn(), pickFile: vi.fn(),
  },
}));
const response = (input: TemporaryExecuteInput, body = '{"ok":true}'): ResponseData => ({
  executionId: input.executionId, status: 200, statusText: 'OK', durationMs: 10,
  sizeBytes: body.length, headers: [], body, truncated: false,
  environmentName: '无环境 · 临时请求', url: 'https://example.com/test',
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sendTemporary).mockImplementation(async input => response(input));
  vi.mocked(api.previewTemporary).mockResolvedValue({
    url: 'https://example.com/test', environmentName: '无环境 · 临时请求',
    serviceName: '临时请求', isProduction: false, resolvedVariables: [],
  });
  vi.mocked(api.cancel).mockResolvedValue(undefined);
});
afterEach(cleanup);

it('无工作区和环境即可编辑发送，只提交临时字段，不触发保存或响应缓存', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const { result } = renderHook(useTemporaryRequests);
  act(() => { result.current.open(); });
  act(() => result.current.updateRequest({
    path: 'https://example.com/test', method: 'POST', bodyType: 'json',
    body: '{"secret":"temporary-only"}', auth: { kind: 'bearer', token: 'temp-token' },
  }));
  await act(async () => result.current.execute());
  expect(api.sendTemporary).toHaveBeenCalledWith({
    executionId: expect.any(String),
    request: {
      url: 'https://example.com/test', method: 'POST', query: [], headers: [],
      bodyType: 'json', body: '{"secret":"temporary-only"}', timeoutMs: 30000,
      auth: { kind: 'bearer', token: 'temp-token' }, form: [],
    },
  });
  expect(result.current.execution?.response?.body).toBe('{"ok":true}');
  expect(result.current.hasRunning).toBe(false);
  expect(api.save).not.toHaveBeenCalled();
  expect(api.loadResponse).not.toHaveBeenCalled();
  expect(api.saveResponse).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});

it('多个标签各自保存内存草稿，响应归属发送时的标签', async () => {
  let finish!: (value: ResponseData) => void;
  vi.mocked(api.sendTemporary).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useTemporaryRequests);
  let first = '';
  act(() => { first = result.current.open(); });
  act(() => result.current.updateRequest({ path: 'https://example.com/first' }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.execute(); });
  act(() => { result.current.open(); });
  act(() => result.current.updateRequest({ path: 'https://example.com/second' }));
  await act(async () => result.current.execute());
  const firstInput = vi.mocked(api.sendTemporary).mock.calls[0][0];
  await act(async () => { finish(response(firstInput, 'first-result')); await pending; });
  expect(result.current.request?.path).toBe('https://example.com/second');
  expect(result.current.execution?.response?.body).toBe('{"ok":true}');
  act(() => result.current.select(first));
  expect(result.current.execution?.response?.body).toBe('first-result');
});

it('关闭运行标签会取消，晚到响应不恢复标签；重新打开是空白', async () => {
  let finish!: (value: ResponseData) => void;
  vi.mocked(api.sendTemporary).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useTemporaryRequests);
  let id = '';
  act(() => { id = result.current.open(); });
  act(() => result.current.updateRequest({ path: 'https://example.com/private' }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.execute(); });
  const input = vi.mocked(api.sendTemporary).mock.calls[0][0];
  act(() => result.current.close(id));
  expect(api.cancel).toHaveBeenCalledWith(input.executionId);
  expect(result.current.tabs).toHaveLength(0);
  await act(async () => { finish(response(input, 'do-not-restore')); await pending; });
  expect(result.current.tabs).toHaveLength(0);
  act(() => { result.current.open(); });
  expect(result.current.request?.path).toBe('');
  expect(result.current.request?.auth).toEqual({ kind: 'none' });
  expect(result.current.execution).toBeUndefined();
});

it('同标签发送中不重复执行，取消反馈保留到请求结束', async () => {
  let finish!: (value: ResponseData) => void;
  vi.mocked(api.sendTemporary).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useTemporaryRequests);
  act(() => { result.current.open(); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.execute(); });
  await act(async () => result.current.execute());
  expect(api.sendTemporary).toHaveBeenCalledTimes(1);
  await act(async () => result.current.cancel());
  expect(result.current.execution?.cancelRequested).toBe(true);
  const input = vi.mocked(api.sendTemporary).mock.calls[0][0];
  await act(async () => { finish(response(input)); await pending; });
  expect(result.current.hasRunning).toBe(false);
});

it('拒绝执行 ID 不匹配的响应，清除后不保留错误或正文', async () => {
  vi.mocked(api.sendTemporary).mockImplementation(async input => ({ ...response(input), executionId: 'other' }));
  const { result } = renderHook(useTemporaryRequests);
  act(() => { result.current.open(); });
  await act(async () => result.current.execute());
  expect(result.current.execution?.response).toBeUndefined();
  expect(result.current.execution?.error).toContain('执行 ID');
  act(() => result.current.clearResponse());
  expect(result.current.execution).toBeUndefined();
});

it('关闭全部和卸载都会取消运行请求，之后不恢复任何数据', async () => {
  vi.mocked(api.sendTemporary).mockReturnValue(new Promise(() => {}));
  const { result, unmount } = renderHook(useTemporaryRequests);
  act(() => { result.current.open(); void result.current.execute(); });
  act(() => { result.current.open(); void result.current.execute(); });
  act(() => result.current.closeAll());
  expect(api.cancel).toHaveBeenCalledTimes(2);
  expect(result.current.tabs).toHaveLength(0);
  act(() => { result.current.open(); void result.current.execute(); });
  unmount();
  expect(api.cancel).toHaveBeenCalledTimes(3);
});

it('脱敏预览仅存当前标签，编辑后清空；过时的预览不覆盖新草稿', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.previewTemporary>>) => void;
  vi.mocked(api.previewTemporary).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useTemporaryRequests);
  act(() => { result.current.open(); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.execute(true); });
  act(() => result.current.updateRequest({ path: 'https://example.com/new' }));
  await act(async () => {
    finish({ url: 'https://example.com/old', environmentName: '', serviceName: '', isProduction: false, resolvedVariables: [] });
    await pending;
  });
  expect(result.current.preview).toBeNull();
  expect(api.sendTemporary).not.toHaveBeenCalled();
});

it('关闭标签后的异步编辑不会覆盖其他标签或恢复已关闭标签', () => {
  const { result } = renderHook(useTemporaryRequests);
  let first = '';
  act(() => { first = result.current.open(); });
  const lateUpdate = result.current.updateRequest;
  act(() => { result.current.open(); });
  act(() => result.current.updateRequest({ path: 'https://example.com/second' }));
  act(() => result.current.close(first));
  act(() => lateUpdate({ path: 'https://example.com/late-first' }));
  expect(result.current.tabs).toHaveLength(1);
  expect(result.current.request?.path).toBe('https://example.com/second');
});
