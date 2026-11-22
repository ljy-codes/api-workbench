import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { foldedRanges } from '@codemirror/language';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import JsonToolsDialog from './JsonToolsDialog';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => { userEvent.setup(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openTool(source: string) {
  render(<JsonToolsDialog onClose={vi.fn()} />);
  const content = await screen.findByLabelText('临时 JSON 内容');
  const view = EditorView.findFromDOM(content)!;
  act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }); });
  return view;
}

it('默认保留 null，勾选后压缩时去除对象 null 字段并清理多余逗号', async () => {
  const view = await openTool('{"user":null,"data":[null,{"id":0,"empty":null,},],}');
  expect((screen.getByRole('checkbox', { name: '去除 null 字段' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '格式化展开' }));
  expect(view.state.doc.toString()).toBe('{\n  "user": null,\n  "data": [\n    null,\n    {\n      "id": 0,\n      "empty": null\n    }\n  ]\n}');
  fireEvent.click(screen.getByRole('checkbox', { name: '去除 null 字段' }));
  fireEvent.click(screen.getByRole('button', { name: '压缩一行' }));
  expect(view.state.doc.toString()).toBe('{"data":[null,{"id":0}]}');
  fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('{"data":[null,{"id":0}]}'));
});

it('按模块折叠后搜索能展开并定位隐藏命中，支持上一个、下一个循环', async () => {
  const view = await openTool('{"data":{"name":"target"},"other":{"name":"target"}}');
  fireEvent.click(screen.getByRole('button', { name: '收起模块' }));
  await waitFor(() => expect(foldedRanges(view.state).size).toBe(2));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索 JSON' }), { target: { value: 'target' } });
  fireEvent.click(screen.getByRole('button', { name: '下一个匹配' }));
  await waitFor(() => expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe('target'));
  const first = view.state.selection.main.from;
  expect(foldedRanges(view.state).size).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '下一个匹配' }));
  await waitFor(() => expect(view.state.selection.main.from).toBeGreaterThan(first));
  fireEvent.click(screen.getByRole('button', { name: '上一个匹配' }));
  await waitFor(() => expect(view.state.selection.main.from).toBe(first));
  fireEvent.click(screen.getByRole('button', { name: '格式化展开' }));
  await waitFor(() => expect(foldedRanges(view.state).size).toBe(0));
});

it('无效输入和剪贴板失败都有提示，原文保持不变', async () => {
  const source = '{"bad":1,,}';
  const view = await openTool(source);
  fireEvent.click(screen.getByRole('button', { name: '格式化展开' }));
  expect(screen.getByRole('alert').textContent).toContain('JSON');
  expect(view.state.doc.toString()).toBe(source);
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('复制失败'));
  expect(view.state.doc.toString()).toBe(source);
});

it('工具处理与搜索全程不写存储或网络，清空也移除编辑器撤销历史', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const view = await openTool('{"temporarySecret":"only in memory"}');
  fireEvent.click(screen.getByRole('button', { name: '格式化展开' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索 JSON' }), { target: { value: 'Secret' } });
  fireEvent.click(screen.getByRole('button', { name: '清空内容' }));
  const emptyView = EditorView.findFromDOM(screen.getByLabelText('临时 JSON 内容'))!;
  expect(emptyView.state.doc.toString()).toBe('');
  expect(emptyView).not.toBe(view);
  fireEvent.keyDown(screen.getByLabelText('临时 JSON 内容'), { key: 'z', ctrlKey: true });
  expect(emptyView.state.doc.toString()).toBe('');
  expect(storage).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('提供四个工具页签，切换后保留当前窗口的格式化原文并支持键盘切换', async () => {
  const source = '{"id":9223372036854775807}';
  const view = await openTool(source);
  expect(screen.getByRole('tab', { name: '格式化' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: '字段提取' }));
  expect(await screen.findByRole('textbox', { name: '提取路径' })).toBeTruthy();
  expect(view.state.doc.toString()).toBe(source);
  fireEvent.click(screen.getByRole('tab', { name: '格式化' }));
  expect(EditorView.findFromDOM(screen.getByLabelText('临时 JSON 内容'))).toBe(view);
  fireEvent.keyDown(screen.getByRole('tab', { name: '格式化' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '双栏对比' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByLabelText('左侧 JSON')).toBeTruthy();
});
