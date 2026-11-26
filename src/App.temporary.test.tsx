import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace, emptyWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({
  desktop: true, api: {
    load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn(),
    loadResponse: vi.fn(), saveResponse: vi.fn(),
    previewTemporary: vi.fn(), sendTemporary: vi.fn(), pickFile: vi.fn(),
  },
}));
const native = vi.hoisted(() => ({ onCloseRequested: vi.fn(), destroy: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
// Keep editor components and CodeMirror real; only native IPC is replaced.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(emptyWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.save).mockImplementation(async w => ({ ...w, revision: w.revision + 1 }));
  vi.mocked(api.cancel).mockResolvedValue(undefined);
  vi.mocked(api.sendTemporary).mockImplementation(async input => ({
    executionId: input.executionId, status: 200, statusText: 'OK', durationMs: 12,
    sizeBytes: 11, headers: [], body: '{"ok":true}', truncated: false,
    environmentName: '无环境 · 临时请求', url: 'https://example.com/check',
  }));
  native.onCloseRequested.mockResolvedValue(() => {});
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

async function openTemporary() {
  render(<App />);
  await screen.findByRole('button', { name: '创建第一个项目' });
  fireEvent.click(screen.getByRole('button', { name: '临时请求' }));
  return screen.findByLabelText('请求完整地址');
}

it('空工作区无需创建项目或环境，完整 URL 可以通过快捷键发送', async () => {
  const url = await openTemporary();
  expect(screen.getByText('无环境 · 仅内存')).toBeTruthy();
  expect(screen.getByRole('button', { name: '发送请求' })).toBeEnabled();
  expect(screen.getByLabelText('正文类型')).toBeEnabled();
  fireEvent.change(url, { target: { value: 'https://example.com/check?x=1' } });
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(await screen.findByText('200 OK')).toBeTruthy();
  expect(api.sendTemporary).toHaveBeenCalledWith(expect.objectContaining({
    request: expect.objectContaining({ url: 'https://example.com/check?x=1' }),
  }));
  expect(api.send).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
});

it('已有接口没有环境时，提示入口可直接进入临时调试', async () => {
  const workspace = demoWorkspace();
  workspace.projects[0].activeEnvironmentId = null;
  workspace.environments = [];
  workspace.bindings = [];
  vi.mocked(api.load).mockResolvedValue(workspace);
  render(<App />);
  await screen.findByLabelText('接口路径');
  expect(screen.getByRole('button', { name: '发送请求' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '没有环境？临时调试' }));
  fireEvent.change(screen.getByLabelText('请求完整地址'), { target: { value: 'http://127.0.0.1:8080/check' } });
  expect(screen.getByRole('button', { name: '发送请求' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
  await screen.findByText('200 OK');
  expect(api.sendTemporary).toHaveBeenCalledWith(expect.objectContaining({
    request: expect.objectContaining({ url: 'http://127.0.0.1:8080/check' }),
  }));
  expect(api.send).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
});

it('临时凭据直接填写，关闭标签后新建可重新开始', async () => {
  await openTemporary();
  fireEvent.click(screen.getByRole('tab', { name: '鉴权' }));
  fireEvent.change(screen.getByLabelText('鉴权方式'), { target: { value: 'bearer' } });
  fireEvent.change(screen.getByLabelText('临时 Token'), { target: { value: 'local-token' } });
  fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
  await screen.findByText('200 OK');
  expect(api.sendTemporary).toHaveBeenCalledWith(expect.objectContaining({
    request: expect.objectContaining({ auth: { kind: 'bearer', token: 'local-token' } }),
  }));
  fireEvent.click(screen.getByRole('button', { name: '关闭标签 临时请求 1' }));
  expect(screen.queryByLabelText('请求完整地址')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '新建临时请求' }));
  expect(screen.getByLabelText('请求完整地址')).toHaveValue('');
  expect(screen.queryByText('200 OK')).toBeNull();
});

it('临时页 Ctrl+S 不保存普通草稿，返回工作台仍保留原功能', async () => {
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  render(<App />);
  const path = await screen.findByLabelText('接口路径');
  fireEvent.change(path, { target: { value: '/unsaved-standard' } });
  fireEvent.click(screen.getByRole('button', { name: '临时请求' }));
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '接口工作台' }));
  expect(screen.getByLabelText('接口路径')).toHaveValue('/unsaved-standard');
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
});

it('标签支持键盘切换和关闭全部，响应不出现在普通请求时间线', async () => {
  await openTemporary();
  fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
  await screen.findByText('200 OK');
  fireEvent.click(screen.getByRole('button', { name: '新建临时请求' }));
  const tabs = within(screen.getByRole('tablist', { name: '临时接口标签' }));
  fireEvent.keyDown(tabs.getByRole('tab', { name: '切换到 临时请求 2' }), { key: 'ArrowLeft' });
  expect(tabs.getByRole('tab', { name: '切换到 临时请求 1' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('200 OK')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '请求时间线' }));
  expect(await screen.findByText(/还没有执行记录/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭全部临时标签' }));
  expect(screen.queryAllByRole('tab', { name: /切换到 临时请求/ })).toHaveLength(0);
});

it('临时请求运行时关闭应用有退出保护', async () => {
  vi.mocked(api.sendTemporary).mockReturnValue(new Promise(() => {}));
  await openTemporary();
  fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
  const callback = native.onCloseRequested.mock.calls[0][0];
  const preventDefault = vi.fn();
  let pending!: Promise<void>;
  act(() => { pending = callback({ preventDefault }); });
  expect(preventDefault).toHaveBeenCalled();
  expect(await screen.findByRole('dialog', { name: '确认关闭工作台' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => pending);
  expect(native.destroy).not.toHaveBeenCalled();
});

it('文件选择结果晚到时仍属于发起选择的标签', async () => {
  let finish!: (path: string) => void;
  vi.mocked(api.pickFile).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openTemporary();
  fireEvent.change(screen.getByLabelText('正文类型'), { target: { value: 'multipart' } });
  fireEvent.click(screen.getByRole('button', { name: '添加表单项' }));
  fireEvent.change(screen.getByLabelText('表单名称1'), { target: { value: 'upload' } });
  fireEvent.change(screen.getByLabelText('表单类型1'), { target: { value: 'file' } });
  fireEvent.click(screen.getByRole('button', { name: '选择文件1' }));
  fireEvent.click(screen.getByRole('button', { name: '新建临时请求' }));
  fireEvent.change(screen.getByLabelText('正文类型'), { target: { value: 'multipart' } });
  fireEvent.click(screen.getByRole('button', { name: '添加表单项' }));
  fireEvent.change(screen.getByLabelText('表单名称1'), { target: { value: 'second-tab' } });
  await act(async () => finish('C:\\temporary-test\\sample.txt'));
  expect(screen.getByLabelText('表单名称1')).toHaveValue('second-tab');
  expect(screen.getByLabelText('表单值1')).toHaveValue('');
  fireEvent.click(screen.getByRole('tab', { name: '切换到 临时请求 1' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Body' }));
  expect(screen.getByLabelText('表单名称1')).toHaveValue('upload');
  expect(screen.getByLabelText('表单值1')).toHaveValue('C:\\temporary-test\\sample.txt');
});

it('临时响应比较基准按标签保留，切换页面后仍可继续比较', async () => {
  await openTemporary();
  fireEvent.change(screen.getByLabelText('请求完整地址'), { target: { value: 'https://example.com/check' } });
  fireEvent.click(screen.getByRole('button', { name: '发送请求' }));
  await screen.findByText('200 OK');
  await waitFor(() => expect(within(screen.getByLabelText('响应显示格式')).getByRole('option', { name: '响应对比' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'compare' } });
  fireEvent.click(screen.getByRole('button', { name: '设为对比基准' }));
  expect(screen.getByRole('button', { name: '更新对比基准' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新建临时请求' }));
  fireEvent.click(screen.getByRole('tab', { name: '切换到 临时请求 1' }));
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'compare' } });
  expect(screen.getByRole('button', { name: '更新对比基准' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '接口工作台' }));
  fireEvent.click(screen.getByRole('button', { name: '临时请求' }));
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'compare' } });
  expect(screen.getByRole('button', { name: '更新对比基准' })).toBeTruthy();
});
