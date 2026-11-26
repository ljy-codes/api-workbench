import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JsonStringTool } from './JsonStringTool';

beforeEach(() => { userEvent.setup(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function editor(label: '转义原文' | '转义结果') {
  return EditorView.findFromDOM(screen.getByLabelText(label))!;
}

function edit(source: string) {
  const view = editor('转义原文');
  act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }); });
  return view;
}

function convert(source: string, action = '转为字符串') {
  render(<JsonStringTool />);
  edit(source);
  fireEvent.click(screen.getByRole('button', { name: action }));
}

it('两栏有可见标题，结果只读，并说明双引号和每次还原一层', () => {
  render(<JsonStringTool />);
  expect(screen.getByRole('heading', { name: '转义原文' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '转义结果' })).toBeInTheDocument();
  expect(screen.getByLabelText('转义结果')).toHaveAttribute('contenteditable', 'false');
  expect(screen.getByText(/带双引号.*每次.*一层/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
});

it('引号、反斜杠、换行、制表符及中文转为 JSON 字符串，复制完整结果', async () => {
  convert('第一行 "A"\\目录\n第二行\t结束');
  const expected = String.raw`"第一行 \"A\"\\目录\n第二行\t结束"`;
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe(expected));
  expect(editor('转义原文').state.doc.toString()).toBe('第一行 "A"\\目录\n第二行\t结束');
  expect(screen.getByLabelText('转换状态')).toHaveTextContent('已转为');
  fireEvent.click(screen.getByRole('button', { name: '复制转换结果' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(expected));
  expect(screen.getByLabelText('转换状态')).toHaveTextContent('已复制');
});

it('还原字符串每次只处理一层，继续处理将结果回填并撤下旧结果', async () => {
  convert(String.raw`"\"内容\""`, '还原字符串');
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"内容"'));
  expect(screen.getByLabelText('转换状态')).toHaveTextContent('已还原');
  fireEvent.click(screen.getByRole('button', { name: '用结果继续处理' }));
  await waitFor(() => expect(editor('转义原文').state.doc.toString()).toBe('"内容"'));
  expect(editor('转义结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '还原字符串' }));
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('内容'));
});

it.each(['{"a":1}', '[1]', '123', 'null', 'true', '"未闭合', String.raw`"\x41"`])('还原拒绝 %s，错误可见且原文保留', source => {
  convert(source, '还原字符串');
  expect(screen.getByRole('alert')).toHaveTextContent('还原失败');
  expect(editor('转义原文').state.doc.toString()).toBe(source);
  expect(editor('转义结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
});

it('原文一变立即撤下旧结果、禁用复制，并等待明确动作才转换', async () => {
  convert('旧内容');
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"旧内容"'));
  edit('新内容');
  expect(editor('转义结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
  expect(screen.getByLabelText('转换状态')).toHaveTextContent('重新转换');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '转为字符串' }));
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"新内容"'));
});

it('还原得到空字符串仍是有效结果，可以复制', async () => {
  convert('""', '还原字符串');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeEnabled();
  await navigator.clipboard.writeText('previous');
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  fireEvent.click(screen.getByRole('button', { name: '复制转换结果' }));
  await waitFor(() => expect(screen.getByLabelText('转换状态')).toHaveTextContent('已复制'));
  // user-event's clipboard readText rejects empty strings as a missing MIME item.
  expect(writeText).toHaveBeenCalledWith('');
});

it('转换失败撤下上次成功结果，保留当前原文', async () => {
  convert('普通文本');
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"普通文本"'));
  fireEvent.click(screen.getByRole('button', { name: '还原字符串' }));
  expect(screen.getByRole('alert')).toHaveTextContent('还原失败');
  expect(editor('转义原文').state.doc.toString()).toBe('普通文本');
  expect(editor('转义结果').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
});

it('剪贴板失败可见，原文和有效结果保留', async () => {
  convert('完整结果');
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"完整结果"'));
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: '复制转换结果' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('复制失败'));
  expect(editor('转义原文').state.doc.toString()).toBe('完整结果');
  expect(editor('转义结果').state.doc.toString()).toBe('"完整结果"');
});

it.each(['edit', 'clear'] as const)('复制尚未完成时 %s，不允许迟到回调恢复成功提示', async action => {
  convert('临时内容');
  let finish!: () => void;
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '复制转换结果' }));
  if (action === 'edit') edit('修改后');
  else fireEvent.click(screen.getByRole('button', { name: '清空转换' }));
  await act(async () => { finish(); });
  expect(screen.getByLabelText('转换状态')).not.toHaveTextContent('已复制');
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
  expect(editor('转义结果').state.doc.toString()).toBe('');
});

it('清空销毁两编辑器和撤销历史，卸载后重开无草稿或结果', async () => {
  const mounted = render(<JsonStringTool />);
  edit('temporarySecret');
  fireEvent.click(screen.getByRole('button', { name: '转为字符串' }));
  await waitFor(() => expect(editor('转义结果').state.doc.toString()).toBe('"temporarySecret"'));
  const source = editor('转义原文');
  const result = editor('转义结果');
  fireEvent.click(screen.getByRole('button', { name: '清空转换' }));
  expect(editor('转义原文')).not.toBe(source);
  expect(editor('转义结果')).not.toBe(result);
  for (const label of ['转义原文', '转义结果'] as const) {
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'z', ctrlKey: true });
    expect(editor(label).state.doc.toString()).toBe('');
  }
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '复制转换结果' })).toBeDisabled();
  edit('anotherSecret');
  mounted.unmount();
  render(<JsonStringTool />);
  expect(editor('转义原文').state.doc.toString()).toBe('');
  expect(editor('转义结果').state.doc.toString()).toBe('');
});

it('转换、还原、复制和清空全程不写存储或发送网络请求', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
  convert('"temporarySecret"', '还原字符串');
  fireEvent.click(screen.getByRole('button', { name: '复制转换结果' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('temporarySecret'));
  fireEvent.click(screen.getByRole('button', { name: '用结果继续处理' }));
  fireEvent.click(screen.getByRole('button', { name: '转为字符串' }));
  fireEvent.click(screen.getByRole('button', { name: '清空转换' }));
  expect(storage).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
});
