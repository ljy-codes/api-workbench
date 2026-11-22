import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { undo } from '@codemirror/commands';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import DevToolsDialog from './DevToolsDialog';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => { userEvent.setup(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function editor(label = '工具输入') {
  return EditorView.findFromDOM(screen.getByLabelText(label))!;
}
function edit(source: string) {
  const view = editor();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }));
  return view;
}
function open() {
  const onClose = vi.fn();
  const onOpenJson = vi.fn();
  return { ...render(<DevToolsDialog onClose={onClose} onOpenJson={onOpenJson} />), onClose, onOpenJson };
}
async function result(text: string) {
  await waitFor(() => expect(editor('工具结果').state.doc.toString()).toBe(text));
}

it('提供五种工具、明确隐私说明、只读结果和 JSON 快捷入口', () => {
  const { onOpenJson, onClose } = open();
  expect(screen.getByRole('dialog', { name: '临时开发工具箱' })).toBeInTheDocument();
  for (const name of ['URL 编解码', 'Base64 编解码', 'Unix 时间戳', 'JWT 结构查看', 'SQL 字符串列表']) {
    expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  }
  expect(screen.getByText(/关闭即清空/)).toBeInTheDocument();
  expect(screen.getByText(/1 MiB/)).toBeInTheDocument();
  expect(screen.getByLabelText('工具结果')).toHaveAttribute('contenteditable', 'false');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '打开 JSON 工具' }));
  expect(onOpenJson).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('手动转换且不覆盖原文；修改原文立即撤下旧结果并禁止复制', async () => {
  open();
  edit('中文 a+b');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('%E4%B8%AD%E6%96%87%20a%2Bb');
  expect(editor().state.doc.toString()).toBe('中文 a+b');
  fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('%E4%B8%AD%E6%96%87%20a%2Bb'));
  edit('已修改');
  expect(editor('工具结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
  expect(screen.getByLabelText('工具状态')).toHaveTextContent('重新转换');
});

it.each([
  ['URL 编解码', 'URL 解码', '%E4%B8'],
  ['Base64 编解码', 'Base64 解码', '/w=='],
  ['Unix 时间戳', 'ISO 转时间戳', '2024-02-30T00:00:00Z'],
  ['JWT 结构查看', '查看 JWT 结构', 'a.b.c'],
  ['SQL 字符串列表', '转为单引号列表', '"1"x,2'],
])('%s 非法输入明确报错、保留原文和禁用复制', (tab, action, source) => {
  open();
  fireEvent.click(screen.getByRole('tab', { name: tab }));
  edit(source);
  fireEvent.click(screen.getByRole('button', { name: action }));
  expect(screen.getByRole('alert')).toHaveTextContent('原文已保留');
  expect(editor().state.doc.toString()).toBe(source);
  expect(editor('工具结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
});

it('失败的动作也撤下上次成功结果', async () => {
  open();
  edit('%');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('%25');
  fireEvent.click(screen.getByRole('button', { name: 'URL 解码' }));
  expect(screen.getByRole('alert')).toHaveTextContent('原文已保留');
  expect(editor('工具结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
});

it('Base64 使用 UTF-8，解码空文本得到的有效空结果仍可主动复制', async () => {
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'Base64 编解码' }));
  edit('中文🙂\n');
  fireEvent.click(screen.getByRole('button', { name: 'Base64 编码' }));
  await result('5Lit5paH8J+Zggo=');
  fireEvent.click(screen.getByRole('button', { name: '清空工具' }));
  fireEvent.click(screen.getByRole('button', { name: 'Base64 解码' }));
  expect(screen.getByRole('button', { name: '复制结果' })).toBeEnabled();
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
  await waitFor(() => expect(screen.getByLabelText('工具状态')).toHaveTextContent('已复制'));
  expect(write).toHaveBeenCalledWith('');
});

it('SQL 列表支持两种输入、一键复制，编辑后撤下旧结果，重开不保留数据', async () => {
  const mounted = open();
  fireEvent.click(screen.getByRole('tab', { name: 'SQL 字符串列表' }));
  edit('"1","23",\n"001"');
  fireEvent.click(screen.getByRole('button', { name: '转为单引号列表' }));
  await result("'1','23','001'");
  expect(editor().state.doc.toString()).toBe('"1","23",\n"001"');
  fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("'1','23','001'"));
  edit('1,2,3');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '转为单引号列表' }));
  await result("'1','2','3'");
  mounted.unmount();
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'SQL 字符串列表' }));
  expect(editor().state.doc.toString()).toBe('');
  expect(editor('工具结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
});

it('时间戳必须选择单位，输出明确本地与 UTC，单位变化立即失效', async () => {
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'Unix 时间戳' }));
  edit('0');
  fireEvent.click(screen.getByRole('button', { name: '时间戳转日期' }));
  await waitFor(() => expect(editor('工具结果').state.doc.toString()).toContain('1970-01-01T00:00:00.000Z'));
  expect(editor('工具结果').state.doc.toString()).toMatch(/本地时间.*UTC[+-]\d{2}:\d{2}/);
  fireEvent.change(screen.getByRole('combobox', { name: '时间戳单位' }), { target: { value: 'milliseconds' } });
  expect(editor('工具结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
  edit('2024-01-01T08:00:00+08:00');
  fireEvent.click(screen.getByRole('button', { name: 'ISO 转时间戳' }));
  await waitFor(() => expect(editor('工具结果').state.doc.toString()).toContain('1704067200000'));
});

it('JWT 持续标明未验证签名，不把 payload 当登录凭据', async () => {
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'JWT 结构查看' }));
  expect(screen.getByText(/未验证签名.*登录/)).toBeInTheDocument();
  edit('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln');
  fireEvent.click(screen.getByRole('button', { name: '查看 JWT 结构' }));
  await waitFor(() => expect(editor('工具结果').state.doc.toString()).toContain('{"sub":"123"}'));
  expect(editor('工具结果').state.doc.toString()).toContain('Header');
  expect(editor('工具结果').state.doc.toString()).toContain('Payload');
  expect(editor('工具结果').state.doc.toString()).toContain('未验证签名');
});

it('页签可用方向键与 Home/End 导航，切换销毁旧草稿并撤下结果', async () => {
  open();
  edit('secret');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('secret');
  const old = editor();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'URL 编解码' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Base64 编解码' })).toHaveFocus();
  expect(editor()).not.toBe(old);
  expect(editor().state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Base64 编解码' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'SQL 字符串列表' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'SQL 字符串列表' }), { key: 'Home' });
  expect(screen.getByRole('tab', { name: 'URL 编解码' })).toHaveFocus();
  expect(editor().state.doc.toString()).toBe('');
});

it('Tab 和 Shift+Tab 能离开输入编辑器，不会插入缩进或困住键盘焦点', async () => {
  const user = userEvent.setup();
  open();
  edit('keep');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('keep');
  act(() => editor().focus());
  await user.tab();
  expect(screen.getByRole('button', { name: '复制结果' })).toHaveFocus();
  expect(editor().state.doc.toString()).toBe('keep');
  await user.tab({ shift: true });
  expect(screen.getByLabelText('工具输入')).toHaveFocus();
});

it('清空销毁编辑器撤销历史，卸载重开不恢复草稿、结果或工具选择', async () => {
  const mounted = open();
  edit('temporarySecret');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('temporarySecret');
  const oldSource = editor();
  const oldResult = editor('工具结果');
  fireEvent.click(screen.getByRole('button', { name: '清空工具' }));
  expect(editor()).not.toBe(oldSource);
  expect(editor('工具结果')).not.toBe(oldResult);
  for (const label of ['工具输入', '工具结果']) {
    act(() => { undo(editor(label)); });
    expect(editor(label).state.doc.toString()).toBe('');
  }
  fireEvent.click(screen.getByRole('tab', { name: 'JWT 结构查看' }));
  edit('anotherSecret');
  mounted.unmount();
  open();
  expect(screen.getByRole('tab', { name: 'URL 编解码' })).toHaveAttribute('aria-selected', 'true');
  expect(editor().state.doc.toString()).toBe('');
  expect(editor('工具结果').state.doc.toString()).toBe('');
});

it.each(['edit', 'clear', 'switch'] as const)('异步复制迟到后 %s，不恢复过期状态', async action => {
  open();
  edit('secret');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('secret');
  let finish!: () => void;
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
  if (action === 'edit') edit('changed');
  else if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: '清空工具' }));
  else fireEvent.click(screen.getByRole('tab', { name: 'Base64 编解码' }));
  await act(async () => { finish(); });
  expect(screen.getByLabelText('工具状态')).not.toHaveTextContent('已复制');
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
});

it('剪贴板拒绝时提供错误并保留有效结果', async () => {
  open();
  edit('secret');
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  await result('secret');
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('复制失败'));
  expect(editor().state.doc.toString()).toBe('secret');
  expect(editor('工具结果').state.doc.toString()).toBe('secret');
});

it('输入超预算保留原文，显示明确错误且不生成可复制结果', () => {
  open();
  const source = 'a'.repeat(1_048_577);
  edit(source);
  fireEvent.click(screen.getByRole('button', { name: 'URL 编码' }));
  expect(screen.getByRole('alert')).toHaveTextContent('1 MiB');
  expect(editor().state.doc.toString()).toBe(source);
  expect(screen.getByRole('button', { name: '复制结果' })).toBeDisabled();
});

it('全部转换、切换、清空及关闭不访问存储、IPC、网络或自动剪贴板', async () => {
  const storageRead = vi.spyOn(Storage.prototype, 'getItem');
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText');
  const readClipboard = vi.spyOn(navigator.clipboard, 'readText');
  const ipc = vi.fn();
  const database = vi.fn();
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: ipc });
  vi.stubGlobal('indexedDB', { open: database });
  try {
    const mounted = open();
    for (const [tab, action, source] of [
      ['URL 编解码', 'URL 解码', '%E4%B8%AD'],
      ['Base64 编解码', 'Base64 解码', '5Lit'],
      ['Unix 时间戳', '时间戳转日期', '0'],
      ['JWT 结构查看', '查看 JWT 结构', 'e30.e30.'],
      ['SQL 字符串列表', '转为单引号列表', '"01",2,3'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      edit(source);
      fireEvent.click(screen.getByRole('button', { name: action }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '清空工具' }));
    }
    mounted.unmount();
    for (const spy of [storageRead, storageWrite, fetchSpy, xhr, ipc, database, clipboard, readClipboard]) {
      expect(spy).not.toHaveBeenCalled();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
