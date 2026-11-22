import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloseRequestedEvent } from '@tauri-apps/api/window';
import { useNativeClose } from './useNativeClose';

const native = vi.hoisted(() => ({
  listen: vi.fn(), destroy: vi.fn(), unlisten: vi.fn(), getWindow: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: native.getWindow }));
let handler: (event: CloseRequestedEvent) => Promise<void>;
const closeEvent = () => ({ preventDefault: vi.fn() }) as unknown as CloseRequestedEvent;
const defaults = () => ({ desktop: true, dirty: false, running: false, busy: false, dialogOpen: false, confirm: vi.fn().mockResolvedValue(false), onError: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  native.getWindow.mockReturnValue({ onCloseRequested: native.listen, destroy: native.destroy });
  native.listen.mockImplementation(async (callback: typeof handler) => { handler = callback; return native.unlisten; });
  native.destroy.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe('桌面原生窗口关闭保护', () => {
  it('浏览器模式不注册 Tauri 原生监听', () => {
    renderHook(() => useNativeClose({ ...defaults(), desktop: false }));
    expect(native.getWindow).not.toHaveBeenCalled();
  });
  it('有未保存修改时立即阻止关闭，取消则不销毁窗口', async () => {
    const options = { ...defaults(), dirty: true };
    renderHook(() => useNativeClose(options));
    await waitFor(() => expect(native.listen).toHaveBeenCalledTimes(1));
    const event = closeEvent();
    await act(() => handler(event));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(options.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('尚未保存') }));
    expect(native.destroy).not.toHaveBeenCalled();
  });
  it('运行中关闭提示服务端可能仍执行，确认后 destroy 不再次 close', async () => {
    const options = { ...defaults(), running: true };
    options.confirm.mockResolvedValue(true);
    renderHook(() => useNativeClose(options));
    const event = closeEvent();
    await act(() => handler(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(options.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('服务端可能仍在执行') }));
    expect(native.destroy).toHaveBeenCalledTimes(1);
  });
  it('连续关闭事件共用一次确认，且先阻止关闭再异步等待', async () => {
    let settle!: (value: boolean) => void;
    const options = { ...defaults(), dirty: true };
    options.confirm.mockReturnValue(new Promise<boolean>(resolve => { settle = resolve; }));
    renderHook(() => useNativeClose(options));
    const first = closeEvent();
    let pending!: Promise<void>;
    act(() => { pending = handler(first); });
    expect(first.preventDefault).toHaveBeenCalled();
    const second = closeEvent();
    await act(() => handler(second));
    expect(second.preventDefault).toHaveBeenCalled();
    expect(options.confirm).toHaveBeenCalledTimes(1);
    await act(async () => { settle(true); await pending; });
    expect(native.destroy).toHaveBeenCalledTimes(1);
  });
  it('使用最新 dirty 状态，卸载时解除监听', async () => {
    const options = defaults();
    const { rerender, unmount } = renderHook(({ dirty }) => useNativeClose({ ...options, dirty }), { initialProps: { dirty: false } });
    rerender({ dirty: true });
    await act(() => handler(closeEvent()));
    expect(options.confirm).toHaveBeenCalledTimes(1);
    unmount();
    expect(native.unlisten).toHaveBeenCalledTimes(1);
  });
  it('正在显示其他确认时不覆盖已有对话框', async () => {
    const options = { ...defaults(), dirty: true, dialogOpen: true };
    renderHook(() => useNativeClose(options));
    const event = closeEvent();
    await act(() => handler(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(options.confirm).not.toHaveBeenCalled();
  });
  it('无草稿且无运行任务时允许原生默认关闭', async () => {
    const options = defaults();
    renderHook(() => useNativeClose(options));
    const event = closeEvent();
    await act(() => handler(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(options.confirm).not.toHaveBeenCalled();
  });
  it('销毁窗口失败会显示错误，不伪装关闭成功', async () => {
    native.destroy.mockRejectedValueOnce('权限不足');
    const options = { ...defaults(), dirty: true };
    options.confirm.mockResolvedValue(true);
    renderHook(() => useNativeClose(options));
    await act(() => handler(closeEvent()));
    expect(options.onError).toHaveBeenCalledWith(expect.stringContaining('权限不足'));
  });
});
