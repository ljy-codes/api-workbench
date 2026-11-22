import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import App from './App';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);
it('主导航可打开和关闭独立时间线，窗口内快捷键不触发网络请求', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  render(<App />);
  const button = screen.getByRole('button', { name: '请求时间线' });
  fireEvent.click(button);
  await screen.findByRole('dialog', { name: '请求时间线' });
  expect(screen.getByText(/还没有执行记录/)).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '请求时间线' })).toBeNull());
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});
