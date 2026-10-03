import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({ desktop: true, api: { load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn(), loadResponse: vi.fn(), saveResponse: vi.fn(), clearResponse: vi.fn(), clearResponses: vi.fn(), compactStorage: vi.fn() } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock('@uiw/react-codemirror', () => ({ default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => <textarea aria-label="代码编辑器" value={value} onChange={e => onChange?.(e.target.value)} /> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.save).mockImplementation(async w => ({ ...w, revision: w.revision + 1 }));
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.saveResponse).mockResolvedValue(undefined);
  vi.mocked(api.clearResponse).mockResolvedValue(undefined);
  vi.mocked(api.clearResponses).mockResolvedValue(undefined);
  vi.mocked(api.compactStorage).mockResolvedValue(undefined);
  vi.mocked(api.preview).mockResolvedValue({ url: 'https://api.example.com/users', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [] });
  vi.mocked(api.send).mockImplementation(async input => ({ executionId: input.executionId, status: 200, statusText: 'OK', durationMs: 12, sizeBytes: 2, headers: [], body: '{}', truncated: false, environmentName: '开发环境', url: 'https://api.example.com/users' }));
});
afterEach(cleanup);
describe('桌面发送快捷键', () => {
  it('Ctrl+Enter 在输入框只触发发送，不再传播给编辑器的换行快捷键', async () => {
    render(<App />);
    const input = await screen.findByLabelText('接口路径');
    await act(async () => {});
    const editorShortcut = vi.fn();
    input.addEventListener('keydown', editorShortcut);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, repeat: true });
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(editorShortcut).not.toHaveBeenCalled();
  });
  it('中文输入法正在组合输入时，不触发发送', async () => {
    render(<App />);
    const input = await screen.findByLabelText('接口路径');
    await act(async () => {});
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(api.preview).not.toHaveBeenCalled();
  });
  it('Ctrl+S 保存当前环境的正文草稿，不触发浏览器默认操作', async () => {
    render(<App />);
    const input = await screen.findByLabelText('接口路径');
    fireEvent.change(input, { target: { value: '/saved' } });
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.save).mock.calls[0][0].requests[0].path).toBe('/saved');
    expect(await screen.findByText('已保存')).toBeTruthy();
  });
  it.each([false, true])('真实清理确认关闭后调用 hook，清正文=%s', async clearBodies => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    if (clearBodies) fireEvent.click(screen.getByRole('checkbox', { name: /同时清空请求正文和表单/ }));
    fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
    const dialog = await screen.findByRole('dialog', { name: '确认清理所有项目的数据？' });
    expect(within(dialog).getByText(/已有手动备份不受影响/)).toBeTruthy();
    expect(api.clearResponses).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(api.clearResponses).toHaveBeenCalledTimes(1));
    expect(api.compactStorage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('数据清理完成')).toBeTruthy();
    if (clearBodies) expect(vi.mocked(api.save).mock.calls[0][0].requests.every(request => !request.body && !request.form?.length)).toBe(true);
    else expect(api.save).not.toHaveBeenCalled();
  });
  it('取消真实清理确认不调用任何清理 IPC', async () => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await act(async () => {});
    expect(api.clearResponses).not.toHaveBeenCalled();
    expect(api.compactStorage).not.toHaveBeenCalled();
  });
  it.each([false, true])('确认事件批处理尚未提交时仍调用真实 hook 清理，清正文=%s', async clearBodies => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    if (clearBodies) fireEvent.click(screen.getByRole('checkbox', { name: /同时清空请求正文和表单/ }));
    fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
    const dialog = await screen.findByRole('dialog', { name: '确认清理所有项目的数据？' });
    // Do not let fireEvent's synchronous act flush hide a stale confirmation closure.
    await act(async () => {
      within(dialog).getByRole('button', { name: '确认清理' }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(api.clearResponses).toHaveBeenCalledTimes(1));
    expect(api.compactStorage).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledTimes(clearBodies ? 1 : 0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('数据清理完成')).toBeTruthy();
  });
  it.each(['response', 'compact'] as const)('真实 hook 部分清理失败 %s，不显示全部完成且可重试', async stage => {
    if (stage === 'response') vi.mocked(api.clearResponses).mockRejectedValueOnce(new Error('SQLite busy'));
    else vi.mocked(api.compactStorage).mockRejectedValueOnce(new Error('compact failed'));
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /同时清空请求正文和表单/ }));
    fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清理' }));
    expect(await screen.findByText(stage === 'response' ? /请求正文和表单已清空并保存；响应缓存清理失败/ : /数据已清理，但空间回收失败/)).toBeTruthy();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.clearResponses).toHaveBeenCalledTimes(1);
    expect(api.compactStorage).toHaveBeenCalledTimes(stage === 'response' ? 0 : 1);
    expect(screen.getByRole('alert').textContent).toContain('未完成');
    expect(screen.queryByText('数据清理完成')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '清理数据' }).matches(':disabled')).toBe(false);
  });
  it('清除当前缓存仅调用当前接口/环境，不清全部缓存', async () => {
    vi.mocked(api.loadResponse).mockResolvedValue({ executionId: 'cached', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 6, body: 'cached', headers: [], environmentName: '开发环境', truncated: false, url: 'https://example.test' });
    render(<App />);
    await screen.findByText('200 OK');
    fireEvent.click(screen.getByRole('button', { name: '清除当前响应' }));
    await waitFor(() => expect(api.clearResponse).toHaveBeenCalledWith('demo-list', 'demo-dev'));
    expect(await screen.findByText('响应将在这里呈现')).toBeTruthy();
    expect(api.clearResponses).not.toHaveBeenCalled();
  });
  it('自定义环境下拉自动保存原环境配置，切换后不会保留鉴权的无效局部输入', async () => {
    const workspace = demoWorkspace();
    workspace.requests[0].auth = { kind: 'bearer', token: '{{base}}' };
    vi.mocked(api.load).mockResolvedValue(workspace);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('参数值1'), { target: { value: 'dev-only' } });
    fireEvent.click(screen.getByRole('tab', { name: '鉴权' }));
    fireEvent.change(screen.getByLabelText('Token 变量引用'), { target: { value: '{{unfinished' } });
    fireEvent.click(screen.getByRole('combobox', { name: '当前环境' }));
    fireEvent.click(screen.getByRole('option', { name: '生产环境 生产' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '当前环境' }).textContent).toContain('生产环境'));
    expect(api.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(api.save).mock.calls[0][0];
    expect(saved.requests[0].environmentConfigs?.['demo-dev'].query[0].value).toBe('dev-only');
    expect(saved.requests[0].query[0].value).toBe('1');
    expect(screen.queryByDisplayValue('{{unfinished')).toBeNull();
    expect((screen.getByLabelText('参数值1') as HTMLInputElement).value).toBe('1');
    fireEvent.click(screen.getByRole('tab', { name: '鉴权' }));
    expect((screen.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{base}}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('环境切换自动保存失败时，组合框仍显示原环境且草稿不丢失', async () => {
    vi.mocked(api.save).mockRejectedValueOnce(new Error('磁盘已满'));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('参数值1'), { target: { value: 'keep-me' } });
    fireEvent.click(screen.getByRole('combobox', { name: '当前环境' }));
    fireEvent.click(screen.getByRole('option', { name: '生产环境 生产' }));
    expect(await screen.findByText(/自动保存失败.*磁盘已满/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '当前环境' }).textContent).toContain('开发环境');
    expect((screen.getByLabelText('参数值1') as HTMLInputElement).value).toBe('keep-me');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('请求进行中禁用单条清理与工作区清理，完成后恢复', async () => {
    let finish!: (response: Awaited<ReturnType<typeof api.send>>) => void;
    vi.mocked(api.send).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.keyDown(await screen.findByLabelText('接口路径'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '清除当前响应' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    expect(screen.getByRole('button', { name: '清理数据' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => finish({ executionId: vi.mocked(api.send).mock.calls[0][0].executionId, status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 2, body: '{}', headers: [], truncated: false, environmentName: '开发环境', url: 'https://example.test' }));
    expect(screen.getByRole('button', { name: '清理数据' }).matches(':disabled')).toBe(false);
  });
});
