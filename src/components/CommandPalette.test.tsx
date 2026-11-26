import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { COMMANDS } from '../lib/commands';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

it('按关键词过滤、方向键选择并回车执行命令', () => {
  const onExecute = vi.fn();
  render(<CommandPalette commands={COMMANDS} onExecute={onExecute} onClose={vi.fn()} />);

  const search = screen.getByRole('searchbox', { name: '搜索命令' });
  fireEvent.change(search, { target: { value: 'json' } });
  expect(screen.getByRole('option', { name: /打开 JSON 工具/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: '保存全部修改' })).toBeNull();
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ id: 'open-json-tools' }));
});

it('支持 Home/End、禁用态和 Escape 关闭', () => {
  const onExecute = vi.fn();
  const onClose = vi.fn();
  render(<CommandPalette commands={COMMANDS} disabled={new Set(['save'])} onExecute={onExecute} onClose={onClose} />);
  const search = screen.getByRole('searchbox', { name: '搜索命令' });
  expect(screen.getByRole('option', { name: /保存全部修改/ })).toBeDisabled();
  fireEvent.keyDown(search, { key: 'End' });
  expect(screen.getByRole('option', { name: /打开快捷键总览/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(search, { key: 'Home' });
  expect(screen.getByRole('option', { name: /保存全部修改/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});
