import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { emptyWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({
  desktop: true,
  api: { load: vi.fn(), save: vi.fn(), send: vi.fn(), preview: vi.fn(), loadResponse: vi.fn() },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(emptyWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
});
afterEach(cleanup);

it('无项目也可打开临时开发工具箱，窗口中的快捷键不保存或发送，关闭恢复入口焦点', async () => {
  render(<App />);
  await screen.findByRole('button', { name: '创建第一个项目' });
  const trigger = screen.getByRole('button', { name: /^临时开发工具箱$/ });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: /^临时开发工具箱$/ }, { timeout: 5000 });
  fireEvent.keyDown(dialog, { key: 's', ctrlKey: true });
  fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });
  expect(api.save).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole('dialog', { name: '临时开发工具箱' })).toBeNull();
});

it('从工具箱打开原 JSON 工具时只保留一个工具窗口', async () => {
  render(<App />);
  await screen.findByRole('button', { name: '创建第一个项目' });
  fireEvent.click(screen.getByRole('button', { name: /^临时开发工具箱$/ }));
  const dialog = await screen.findByRole('dialog', { name: /^临时开发工具箱$/ }, { timeout: 5000 });
  fireEvent.click(within(dialog).getByRole('button', { name: /JSON 工具/ }));
  expect(await screen.findByRole('dialog', { name: /^JSON 工具$/ })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: '临时开发工具箱' })).toBeNull();
});
