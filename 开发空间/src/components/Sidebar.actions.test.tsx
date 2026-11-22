import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { demoWorkspace, newRequest } from '../lib/workspace';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

it('一键收起服务和所有层级目录，保留选中接口并清除搜索', () => {
  const workspace = demoWorkspace();
  workspace.folders.push({ id: 'nested', serviceId: 'demo-users', parentId: 'demo-folder', name: '子目录' });
  workspace.requests.push({ ...newRequest('demo-users', 'nested'), name: '子目录接口' });
  const onSelect = vi.fn();
  render(<Sidebar workspace={workspace} selectedId="demo-list" onSelect={onSelect} onManage={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('搜索接口'), { target: { value: '用户' } });
  fireEvent.click(screen.getByRole('button', { name: '一键收起' }));
  expect(screen.getByLabelText('搜索接口')).toHaveValue('');
  expect(screen.getByRole('button', { name: /用户服务/ })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '用户管理' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /用户服务/ }));
  expect(screen.getByRole('button', { name: '用户管理' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: '用户管理' }));
  expect(screen.getByRole('button', { name: '子目录' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: /获取用户列表/ })).toHaveClass('selected');
  expect(onSelect).not.toHaveBeenCalled();
});

it.each([
  ['用户服务', null],
  ['用户管理', 'demo-folder'],
  ['GET 获取用户列表', 'demo-folder'],
])('右键 %s 可在对应位置添加接口，不切换选中接口', (name, parentId) => {
  const onCreate = vi.fn(), onSelect = vi.fn();
  render(<Sidebar workspace={demoWorkspace()} selectedId="demo-list" onSelect={onSelect} onManage={vi.fn()} onCreate={onCreate} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: name === '用户服务' ? /用户服务/ : name }), { clientX: 120, clientY: 160 });
  expect(screen.getByRole('menu', { name: '添加目录或接口' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '添加接口' }));
  expect(onCreate).toHaveBeenCalledWith({ kind: 'request', serviceId: 'demo-users', parentId });
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('右键菜单支持键盘、Escape、外部点击和滚动关闭', () => {
  render(<Sidebar workspace={demoWorkspace()} selectedId={null} onSelect={vi.fn()} onManage={vi.fn()} onCreate={vi.fn()} />);
  const folder = screen.getByRole('button', { name: '用户管理' });
  fireEvent.keyDown(folder, { key: 'F10', shiftKey: true });
  expect(screen.getByRole('menuitem', { name: '添加目录' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '添加目录' }), { key: 'ArrowDown' });
  expect(screen.getByRole('menuitem', { name: '添加接口' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '添加接口' }), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(folder).toHaveFocus();
  fireEvent.contextMenu(folder);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.contextMenu(folder);
  fireEvent.scroll(document.querySelector('.service-tree')!);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('忙碌时禁用收起及创建，切换项目关闭旧位置的菜单', () => {
  const workspace = demoWorkspace();
  const props = { workspace, selectedId: null, onSelect: vi.fn(), onManage: vi.fn(), onCreate: vi.fn() };
  const { rerender } = render(<Sidebar {...props} disabled />);
  expect(screen.getByRole('button', { name: '一键收起' })).toBeDisabled();
  fireEvent.contextMenu(screen.getByRole('button', { name: '用户管理' }));
  expect(screen.queryByRole('menu')).toBeNull();
  rerender(<Sidebar {...props} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: '用户管理' }));
  expect(screen.getByRole('menu')).toBeTruthy();
  rerender(<Sidebar {...props} workspace={{ ...workspace, activeProjectId: null }} />);
  expect(screen.queryByRole('menu')).toBeNull();
  rerender(<Sidebar {...props} />);
  expect(screen.queryByRole('menu')).toBeNull();
});
