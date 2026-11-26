import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import { demoWorkspace } from '../lib/workspace';
import { useWorkbench } from './useWorkbench';

vi.mock('../lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), loadResponse: vi.fn(), save: vi.fn(), writeProjectFile: vi.fn(),
} }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
});
afterEach(cleanup);

describe('可选择导出的原生结果', () => {
  it('取消文件选择返回独立取消状态，不误报成功或改变草稿', async () => {
    vi.mocked(api.writeProjectFile).mockResolvedValue(null);
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const original = structuredClone(result.current.workspace);
    await act(async () => {
      expect(await result.current.writeSelected({ 'demo-project': ['demo-dev'] })).toBeNull();
    });
    expect(result.current.workspace).toEqual(original);
    expect(result.current.notice).toBe('');
    expect(result.current.busy).toBe(false);
    expect(api.save).not.toHaveBeenCalled();
  });
  it('成功写入只导出勾选环境，返回成功且不写数据库', async () => {
    vi.mocked(api.writeProjectFile).mockResolvedValue('C:\\export.json');
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.writeSelected({ 'demo-project': ['demo-dev'] })).toBe(true);
    });
    const document = JSON.parse(vi.mocked(api.writeProjectFile).mock.calls[0][0]);
    expect(document.workspace.environments.map((e: { id: string }) => e.id)).toEqual(['demo-dev']);
    expect(document.workspace.bindings.every((b: { environmentId: string }) => b.environmentId === 'demo-dev')).toBe(true);
    expect(result.current.notice).toContain('C:\\export.json');
    expect(api.save).not.toHaveBeenCalled();
  });
});
