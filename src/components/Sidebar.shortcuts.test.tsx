import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { demoWorkspace } from '../lib/workspace';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

const props = {
  workspace: demoWorkspace(),
  selectedId: 'demo-list',
  onSelect: vi.fn(),
  onManage: vi.fn(),
};

it('空闲状态按斜杠聚焦搜索，Esc 清空并失焦', () => {
  render(<Sidebar {...props} />);
  const search = screen.getByLabelText('搜索接口');
  fireEvent.keyDown(document, { key: '/' });
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: '用户' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(search).toHaveValue('');
  expect(search).not.toHaveFocus();
});

it.each([{ ctrlKey: true }, { metaKey: true }])('按修饰键 K 聚焦搜索框', ({ ctrlKey, metaKey }) => {
  render(<Sidebar {...props} />);
  fireEvent.keyDown(document, { key: 'k', ctrlKey, metaKey });
  expect(screen.getByLabelText('搜索接口')).toHaveFocus();
});

it('在输入控件和 CodeMirror 中不拦截快捷键', () => {
  render(<Sidebar {...props} />);
  const search = screen.getByLabelText('搜索接口');
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  fireEvent.keyDown(input, { key: '/' });
  expect(search).not.toHaveFocus();

  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  document.body.append(editor);
  editor.focus();
  fireEvent.keyDown(editor, { key: '/' });
  expect(search).not.toHaveFocus();
});
