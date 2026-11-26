import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { DEFAULT_PREFERENCES, updatePreferences } from './lib/preferences';

vi.mock('./components/CodeEditor', () => ({ default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => <textarea aria-label="代码编辑器" value={value} onChange={e => onChange?.(e.target.value)} /> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => { localStorage.clear(); updatePreferences(DEFAULT_PREFERENCES); });
afterEach(cleanup);

function load() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '载入内存示例' }));
  return within(screen.getByRole('complementary'));
}

it.each([
  ['订单服务', '添加接口', '新建接口', 'demo-orders', '', '订单查询'],
  ['用户管理', '添加接口', '新建接口', 'demo-users', 'demo-folder', '快捷查询'],
  ['用户管理', '添加目录', '新建目录', 'demo-users', 'demo-folder', '嵌套目录'],
] as const)('右键 %s → %s，预填归属且留在工作台保留草稿', (node, action, title, serviceId, folderId, name) => {
  const sidebar = load();
  fireEvent.change(screen.getByLabelText('参数值1'), { target: { value: '草稿保留' } });
  fireEvent.contextMenu(sidebar.getByRole('button', { name: node === '订单服务' ? /订单服务/ : node }));
  fireEvent.click(screen.getByRole('menuitem', { name: action }));
  const dialog = within(screen.getByRole('dialog', { name: title }));
  expect(dialog.getByLabelText('所属服务')).toHaveValue(serviceId);
  expect(dialog.getByLabelText(action === '添加目录' ? '上级目录' : '所属目录')).toHaveValue(folderId);
  fireEvent.change(dialog.getByLabelText('名称'), { target: { value: name } });
  fireEvent.click(dialog.getByRole('button', { name: '应用到工作区' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(sidebar.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
  expect(screen.getByLabelText('参数值1')).toHaveValue('草稿保留');
  expect(screen.getByRole('button', { name: '接口工作台' })).toHaveAttribute('aria-current', 'page');
});

it('快捷添加沿用同位置重名校验，取消不新增', () => {
  const sidebar = load();
  fireEvent.contextMenu(sidebar.getByRole('button', { name: '用户管理' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '添加接口' }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '获取用户列表' } });
  fireEvent.click(screen.getByRole('button', { name: '应用到工作区' }));
  expect(screen.getByRole('alert')).toHaveTextContent('同一位置已存在该名称');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(sidebar.getAllByRole('button', { name: /获取用户列表/ })).toHaveLength(1);
});

it('一键关闭当前项目全部标签，重新打开接口保留编辑内容', async () => {
  const sidebar = load();
  fireEvent.change(screen.getByLabelText('参数值1'), { target: { value: '关闭后保留' } });
  fireEvent.click(sidebar.getByRole('button', { name: /创建用户/ }));
  expect(within(screen.getByRole('tablist', { name: '接口标签' })).getAllByRole('tab')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '关闭全部标签' }));
  expect(within(screen.getByRole('tablist', { name: '接口标签' })).queryAllByRole('tab')).toHaveLength(0);
  expect(screen.getByRole('button', { name: '关闭全部标签' })).toBeDisabled();
  expect(sidebar.getByRole('button', { name: /创建用户/ })).toBeTruthy();
  fireEvent.click(sidebar.getByRole('button', { name: /获取用户列表/ }));
  expect(await screen.findByLabelText('参数值1')).toHaveValue('关闭后保留');
});
