import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import '@testing-library/jest-dom/vitest';
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

it('新工具草稿仅在窗口内保留，关闭重开对比、转义、提取全部清空且不写工作区', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const network = vi.spyOn(globalThis, 'fetch');
  render(<App />);
  await screen.findByRole('button', { name: '创建第一个项目' });
  storage.mockClear();
  network.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'JSON 工具' }));
  const dialog = await screen.findByRole('dialog', { name: 'JSON 工具' });
  const setEditor = async (label: string, text: string) => {
    const editor = EditorView.findFromDOM(await within(dialog).findByLabelText(label))!;
    act(() => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); });
    return editor;
  };
  fireEvent.click(within(dialog).getByRole('tab', { name: '双栏对比' }));
  await setEditor('左侧 JSON', '{"secret":1}');
  await setEditor('右侧 JSON', '{"secret":2}');
  fireEvent.click(within(dialog).getByRole('button', { name: '开始对比' }));
  expect(await within(dialog).findByRole('list', { name: 'JSON 差异' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('tab', { name: '转义还原' }));
  await setEditor('转义原文', '{"secret":"temporary"}');
  fireEvent.click(within(dialog).getByRole('button', { name: '转为字符串' }));
  fireEvent.keyDown(await within(dialog).findByLabelText('转义原文'), { key: 's', ctrlKey: true });
  fireEvent.keyDown(await within(dialog).findByLabelText('转义原文'), { key: 'Enter', ctrlKey: true });
  fireEvent.click(within(dialog).getByRole('tab', { name: '字段提取' }));
  await setEditor('临时 JSON 内容', '{"secret":3}');
  fireEvent.change(await within(dialog).findByRole('textbox', { name: '提取路径' }, { timeout: 5000 }), { target: { value: '$.secret' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '提取字段' }));
  expect(await within(dialog).findByLabelText('提取结果')).toBeTruthy();
  expect(storage).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(screen.getByRole('button', { name: 'JSON 工具' }));
  const reopened = await screen.findByRole('dialog', { name: 'JSON 工具' });
  const expectEmpty = async (label: string) => {
    const editor = EditorView.findFromDOM(await within(reopened).findByLabelText(label))!;
    expect(editor.state.doc.toString()).toBe('');
  };
  await expectEmpty('临时 JSON 内容');
  fireEvent.click(within(reopened).getByRole('tab', { name: '双栏对比' }));
  await expectEmpty('左侧 JSON');
  await expectEmpty('右侧 JSON');
  fireEvent.click(within(reopened).getByRole('tab', { name: '转义还原' }));
  await expectEmpty('转义原文');
  await expectEmpty('转义结果');
  fireEvent.click(within(reopened).getByRole('tab', { name: '字段提取' }));
  expect(await within(reopened).findByRole('textbox', { name: '提取路径' })).toHaveValue('$');
  await expectEmpty('提取结果');
  storage.mockRestore();
  network.mockRestore();
});
