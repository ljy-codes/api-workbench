import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ShortcutsDialog } from './ShortcutsDialog';
import { COMMANDS } from '../lib/commands';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

it('按分组展示与命令定义共享的快捷键说明', () => {
  render(<ShortcutsDialog commands={COMMANDS} onClose={vi.fn()} />);

  expect(screen.getByRole('dialog', { name: '快捷键总览' })).toBeInTheDocument();
  expect(screen.getByText('保存全部修改')).toBeInTheDocument();
  expect(screen.getByText('Ctrl ⇧ T')).toBeInTheDocument();
  expect(screen.getByText('工作台')).toBeInTheDocument();
  expect(screen.getByText('标签')).toBeInTheDocument();
});
