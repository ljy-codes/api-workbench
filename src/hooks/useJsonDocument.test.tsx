import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useJsonDocument } from './useJsonDocument';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('小响应只在正文变化时解析，支持 null/无效和空正文', () => {
  const { result, rerender } = renderHook(({ raw }) => useJsonDocument(raw), { initialProps: { raw: '{"data":null}' } });
  expect(result.current.validJson).toBe(true);
  expect(result.current.value).toEqual({ data: null });
  const snapshot = result.current;
  rerender({ raw: '{"data":null}' });
  expect(result.current).toBe(snapshot);
  rerender({ raw: 'not json' });
  expect(result.current.validJson).toBe(false);
  expect(result.current.formatted).toBe('not json');
});
it('大响应走 Worker，换正文后终止旧任务且忽略过期结果', async () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage?: (event: MessageEvent) => void;
    onerror?: () => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { FakeWorker.instances.push(this); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const raw = JSON.stringify({ data: 'x'.repeat(300_000) });
  const { result, rerender, unmount } = renderHook(({ body }) => useJsonDocument(body), { initialProps: { body: raw } });
  expect(result.current.loading).toBe(true);
  const first = FakeWorker.instances[0];
  expect(first.postMessage).toHaveBeenCalledWith(raw);
  rerender({ body: '{"fresh":true}' });
  expect(first.terminate).toHaveBeenCalled();
  act(() => first.onmessage?.({ data: { validJson: true, formatted: 'stale', value: 'stale' } } as MessageEvent));
  await waitFor(() => expect(result.current.value).toEqual({ fresh: true }));
  unmount();
});
it('Worker 不可用或报错时仍可查看原文且明确降级', () => {
  vi.stubGlobal('Worker', undefined);
  const { result } = renderHook(() => useJsonDocument('x'.repeat(300_000)));
  expect(result.current.loading).toBe(false);
  expect(result.current.notice).toContain('原文');
  expect(result.current.formatted).toHaveLength(300_000);
});
