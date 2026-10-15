import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorState, EditorView } from '@uiw/react-codemirror';
import { afterEach, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor';

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
