import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { emptyWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({
  desktop: true,
  api: { load: vi.fn(), save: vi.fn(), send: vi.fn(), preview: vi.fn(), loadResponse: vi.fn() },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(emptyWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
});
afterEach(cleanup);

it('无项目也可使用 JSON 工具，快捷键不触发工作区保存/发送，关闭再开内容与选择均清空', async () => {
  render(<App />);
  await screen.findByRole('button', { name: '创建第一个项目' });
  fireEvent.click(screen.getByRole('button', { name: 'JSON 工具' }));
  const dialog = await screen.findByRole('dialog', { name: 'JSON 工具' });
  const content = await within(dialog).findByLabelText('临时 JSON 内容');
  const view = EditorView.findFromDOM(content)!;
  act(() => { view.dispatch({ changes: { from: 0, insert: '{"secret":"temporary"}' } }); });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '去除 null 字段' }));
  fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索 JSON' }), { target: { value: 'secret' } });
  fireEvent.keyDown(content, { key: 's', ctrlKey: true });
  fireEvent.keyDown(content, { key: 'Enter', ctrlKey: true });
  expect(api.save).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'JSON 工具' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'JSON 工具' }));
  const reopened = await screen.findByRole('dialog', { name: 'JSON 工具' });
  const emptyView = EditorView.findFromDOM(await within(reopened).findByLabelText('临时 JSON 内容'))!;
  expect(emptyView.state.doc.toString()).toBe('');
  expect((within(reopened).getByRole('checkbox', { name: '去除 null 字段' }) as HTMLInputElement).checked).toBe(false);
  expect((within(reopened).getByRole('searchbox', { name: '搜索 JSON' }) as HTMLInputElement).value).toBe('');
});
