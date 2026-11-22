import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteInput } from '../types';
import { demoWorkspace } from './workspace';
import { RequestExecutionError } from './request-diagnostics';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => native);
import { api } from './ipc';

const input: ExecuteInput = {
  executionId: 'run', environmentId: 'demo-dev', request: demoWorkspace().requests[0],
  temporaryVariables: [], productionConfirmed: false,
};
beforeEach(() => vi.resetAllMocks());

describe('详细发送 IPC', () => {
  it('成功仍返回 ResponseData，旧调用方不必改变', async () => {
    const response = { executionId: 'run', body: '{}' };
    native.invoke.mockResolvedValue({ response, diagnostics: { outcome: 'response', totalMs: 10 } });
    expect(await api.send(input)).toEqual(response);
    expect(native.invoke).toHaveBeenCalledWith('send_request_detailed', { input });
  });

  it('失败保留安全文本及取消分类，供现有错误区和诊断区使用', async () => {
    native.invoke.mockResolvedValue({ error: '请求已取消', diagnostics: { outcome: 'cancelled', totalMs: 5 } });
    const error = await api.send(input).catch(error => error);
    expect(error).toBeInstanceOf(RequestExecutionError);
    expect(error.message).toBe('请求已取消');
    expect(error.diagnostics).toEqual({ outcome: 'cancelled', totalMs: 5 });
  });
});
