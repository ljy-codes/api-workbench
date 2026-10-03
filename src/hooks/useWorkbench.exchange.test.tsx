import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import { exportProject, importProject } from '../lib/exchange';
import { importCurl } from '../lib/curl';
import { demoWorkspace } from '../lib/workspace';
import { useWorkbench } from './useWorkbench';

vi.mock('../lib/ipc', () => ({ desktop: true, api: {
  loadResponse: vi.fn(), saveResponse: vi.fn(), load: vi.fn(), save: vi.fn(), readProjectFile: vi.fn(), writeProjectFile: vi.fn(), backup: vi.fn(),
} }));
// These tests exercise the frontend transaction boundary; parser tests belong to the exchange worker.
vi.mock('../lib/exchange', () => ({ exportProject: vi.fn(), importProject: vi.fn() }));
vi.mock('../lib/curl', () => ({ importCurl: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.saveResponse).mockResolvedValue(undefined);
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(importProject).mockImplementation(w => ({ ...w, projects: [...w.projects, { id: 'imported', name: '导入项目', activeEnvironmentId: null }], activeProjectId: 'imported' }));
  vi.mocked(importCurl).mockImplementation(w => ({ ...w, requests: [...w.requests, { ...w.requests[0], id: 'imported-request', name: '导入接口' }] }));
});
afterEach(cleanup);

describe('交换操作仅生成草稿且原生对话框受忙锁保护', () => {
  it('原生文件读取取消时不调用解析、不改变脏标记', async () => {
    vi.mocked(api.readProjectFile).mockResolvedValue(null);
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    await act(() => result.current.readProject());
    expect(importProject).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
    expect(api.save).not.toHaveBeenCalled();
  });
  it('导入项目使用当前快照，保留已有草稿，不自动持久化', async () => {
    vi.mocked(api.readProjectFile).mockResolvedValue('project-json');
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    act(() => result.current.mutate(w => ({ ...w, requests: w.requests.map(r => ({ ...r, path: '/draft' })) })));
    await act(() => result.current.readProject());
    expect(importProject).toHaveBeenCalledWith(expect.objectContaining({ requests: expect.arrayContaining([expect.objectContaining({ path: '/draft' })]) }), 'project-json');
    expect(result.current.workspace.projects).toHaveLength(2);
    expect(result.current.dirty).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
  });
  it('cURL 导入传入新服务名并打开新增接口标签，不发送或保存', async () => {
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    await act(() => result.current.importCurlText('curl https://example.com', '新服务'));
    expect(importCurl).toHaveBeenCalledWith(expect.any(Object), 'curl https://example.com', '新服务');
    expect(result.current.request?.id).toBe('imported-request');
    expect(result.current.openTabs).toContain('imported-request');
    expect(result.current.dirty).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
  });
  it('非法导入失败不改变工作区并释放忙锁', async () => {
    vi.mocked(importProject).mockImplementation(() => { throw new Error('交换格式无效'); });
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    await act(async () => expect(await result.current.importProjectText('invalid')).toBe(false));
    expect(result.current.notice).toBe('交换格式无效');
    expect(result.current.workspace).toEqual(demoWorkspace());
    expect(result.current.busy).toBe(false);
    expect(result.current.dirty).toBe(false);
  });
  it('导出确认前不写文件，确认后只传脱敏交换函数结果，不保存数据库', async () => {
    vi.mocked(exportProject).mockReturnValue('sanitized');
    vi.mocked(api.writeProjectFile).mockResolvedValue('C:\\export.json');
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    let exporting!: Promise<boolean>;
    act(() => { exporting = result.current.writeProject(); });
    expect(api.writeProjectFile).not.toHaveBeenCalled();
    expect(result.current.confirmation?.message).toContain('普通正文');
    await act(async () => { result.current.confirmation!.resolve(true); result.current.setConfirmation(null); await exporting; });
    expect(exportProject).toHaveBeenCalledWith(expect.any(Object), 'demo-project');
    expect(api.writeProjectFile).toHaveBeenCalledWith('sanitized');
    expect(api.save).not.toHaveBeenCalled();
    expect(result.current.notice).toContain('C:\\export.json');
  });
  it('导出取消不调用交换函数、文件写入或清除草稿', async () => {
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    act(() => result.current.mutate(w => ({ ...w })));
    let exporting!: Promise<boolean>;
    act(() => { exporting = result.current.writeProject(); });
    await act(async () => { result.current.confirmation!.resolve(false); result.current.setConfirmation(null); await exporting; });
    expect(exportProject).not.toHaveBeenCalled();
    expect(api.writeProjectFile).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);
  });
  it('备份调用原生一致性备份接口，不把内存草稿标记为已保存', async () => {
    vi.mocked(api.backup).mockResolvedValue('C:\\backups\\workspace.sqlite3');
    const { result } = renderHook(useWorkbench);
    await waitFor(() => expect(result.current.request).toBeTruthy());
    act(() => result.current.mutate(w => ({ ...w })));
    await act(() => result.current.backup());
    expect(api.backup).toHaveBeenCalledTimes(1);
    expect(api.save).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toContain('不含内存草稿');
  });
});
