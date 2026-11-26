import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowControls } from './WindowControls';

const native = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('../lib/ipc', () => ({ desktop: true }));

afterEach(cleanup);

describe('桌面窗口控制', () => {
  it('分别调用最小化、最大化和关闭窗口能力', () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化或还原窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(native.minimize).toHaveBeenCalledTimes(1);
    expect(native.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);
  });
});
