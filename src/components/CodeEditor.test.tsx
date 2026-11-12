import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorState, EditorView } from '@uiw/react-codemirror';
import { foldable, foldEffect, foldedRanges } from '@codemirror/language';
import { afterEach, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor';
import { createRef } from 'react';
import type { CodeEditorHandle } from './CodeEditor';

afterEach(cleanup);

it('JSON 字段名与不同类型的值使用各自的语法标记，文本模式保持原文', async () => {
  const value = '{"name":"Example","count":42,"enabled":true,"empty":null}';
  const { container, rerender } = render(<CodeEditor value={value} isJson onChange={vi.fn()} />);
  await waitFor(() => expect(container.querySelector('.cm-json-key')?.textContent).toBe('"name"'));
  expect(container.querySelector('.cm-json-string')?.textContent).toBe('"Example"');
  expect(container.querySelector('.cm-json-number')?.textContent).toBe('42');
  expect(container.querySelector('.cm-json-literal')?.textContent).toBe('true');
  rerender(<CodeEditor value={value} isJson={false} readOnly label="响应正文" />);
  expect(container.querySelector('.cm-json-key')).toBeNull();
  expect(screen.getByLabelText('响应正文').textContent).toBe(value);
});

it('响应正文保持可选择但不能编辑，保留行号和折叠能力', () => {
  const value = '{\n  "name": "Example"\n}';
  const { container } = render(<CodeEditor value={value} isJson readOnly label="响应正文" />);
  const content = screen.getByLabelText('响应正文');
  const view = EditorView.findFromDOM(content)!;
  expect(view.state.facet(EditorState.readOnly)).toBe(true);
  expect(view.state.facet(EditorView.editable)).toBe(false);
  expect(content.getAttribute('tabindex')).toBe('0');
  expect(container.querySelector('.cm-lineNumbers')).toBeTruthy();
  expect(container.querySelector('.cm-foldGutter')).toBeTruthy();
  fireEvent.keyDown(content, { key: 'Enter', code: 'Enter' });
  expect(view.state.doc.toString()).toBe(value);
});

it('7525 项大数组尚未完成语法解析时也能折叠并显示数量', async () => {
  const value = JSON.stringify({ code: 200, data: { instanceIds: Array.from({ length: 7525 }, (_, i) => String(i)) } }, null, 2);
  const { container } = render(<CodeEditor value={value} isJson readOnly label="响应正文" />);
  const view = EditorView.findFromDOM(screen.getByLabelText('响应正文'))!;
  const line = view.state.doc.lineAt(value.indexOf('"instanceIds"'));
  const range = foldable(view.state, line.from, line.to);
  expect(range).toEqual({ from: value.indexOf('[') + 1, to: value.lastIndexOf(']') });
  view.dispatch({ effects: foldEffect.of(range!) });
  await waitFor(() => expect(container.querySelector('.cm-foldPlaceholder')?.textContent).toBe('7525 项'));
  expect(view.state.doc.toString()).toBe(value);
  expect(view.state.facet(EditorState.readOnly)).toBe(true);
});

it('折叠计数忽略字符串中的括号、逗号和转义引号', async () => {
  const value = JSON.stringify({ values: ['a,{}[]', 'a\\"b', { nested: [1, 2] }, null] }, null, 2);
  const { container } = render(<CodeEditor value={value} isJson readOnly label="响应正文" />);
  const view = EditorView.findFromDOM(screen.getByLabelText('响应正文'))!;
  const line = view.state.doc.lineAt(value.indexOf('"values"'));
  view.dispatch({ effects: foldEffect.of(foldable(view.state, line.from, line.to)!) });
  await waitFor(() => expect(container.querySelector('.cm-foldPlaceholder')?.textContent).toBe('4 项'));
  fireEvent.click(container.querySelector('.cm-foldPlaceholder')!);
  await waitFor(() => expect(container.querySelector('.cm-foldPlaceholder')).toBeNull());
  expect(view.state.doc.toString()).toBe(value);
});

it('原始文本模式及新正文清除旧折叠范围，格式化原文相同时也生效', async () => {
  const value = JSON.stringify({ data: [1, 2, 3] }, null, 2);
  const { rerender } = render(<CodeEditor value={value} isJson readOnly label="响应正文" />);
  const view = EditorView.findFromDOM(screen.getByLabelText('响应正文'))!;
  view.dispatch({ effects: foldEffect.of({ from: 1, to: value.length - 1 }) });
  expect(foldedRanges(view.state).size).toBe(1);
  rerender(<CodeEditor value={value} isJson={false} readOnly label="响应正文" />);
  await waitFor(() => expect(foldedRanges(view.state).size).toBe(0));
  rerender(<CodeEditor value={value} isJson readOnly label="响应正文" />);
  view.dispatch({ effects: foldEffect.of({ from: 1, to: value.length - 1 }) });
  rerender(<CodeEditor value={'{\n  "other": true\n}'} isJson readOnly label="响应正文" />);
  await waitFor(() => expect(foldedRanges(view.state).size).toBe(0));
  expect(view.state.doc.toString()).toBe('{\n  "other": true\n}');
});

it('字段定位展开遮挡目标的折叠并选中目标，保持其他容器折叠', async () => {
  const value = JSON.stringify({ data: { id: 12 }, other: [1, 2] }, null, 2);
  const ref = createRef<CodeEditorHandle>();
  render(<CodeEditor ref={ref} value={value} isJson readOnly label="定位正文" />);
  const view = EditorView.findFromDOM(screen.getByLabelText('定位正文'))!;
  ref.current!.collapseAll();
  const count = foldedRanges(view.state).size;
  const from = value.indexOf('12');
  ref.current!.revealRange({ from, to: from + 2 });
  expect(view.state.selection.main.from).toBe(from);
  expect(view.state.selection.main.to).toBe(from + 2);
  expect(foldedRanges(view.state).size).toBe(count - 1);
  expect(view.state.doc.toString()).toBe(value);
});

it('JSON 编辑器高亮注释并支持 Mod+/ 注释或恢复选中行', async () => {
  const value = `{
  "name": "Example",
  "enabled": true
}`;
  const { container } = render(<CodeEditor value={value} isJson onChange={vi.fn()} />);
  const content = screen.getByLabelText('请求正文');
  const view = EditorView.findFromDOM(content)!;
  const from = value.indexOf('"name"');
  const to = value.indexOf('"enabled"');
  view.dispatch({ selection: { anchor: from, head: to } });
  fireEvent.keyDown(content, { key: '/', code: 'Slash', ctrlKey: true });
  expect(view.state.doc.toString()).toContain('// "name": "Example",');
  expect(view.state.doc.toString()).toContain('// "enabled": true');
  await waitFor(() => expect(container.querySelector('.cm-json-comment')).toBeTruthy());
  fireEvent.keyDown(content, { key: '/', code: 'Slash', ctrlKey: true });
  expect(view.state.doc.toString()).toBe(value);
});
