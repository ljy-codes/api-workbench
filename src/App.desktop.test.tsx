import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({ desktop: true, api: { load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn() } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock('@uiw/react-codemirror', () => ({ default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => <textarea aria-label="代码编辑器" value={value} onChange={e => onChange?.(e.target.value)} /> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.preview).mockResolvedValue({ url: 'https://api.example.com/users', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [] });
  vi.mocked(api.send).mockImplementation(async input => ({ executionId: input.executionId, status: 200, statusText: 'OK', durationMs: 12, sizeBytes: 2, headers: [], body: '{}', truncated: false, environmentName: '开发环境', url: 'https://api.example.com/users' }));
});
afterEach(cleanup);
describe('桌面发送快捷键', () => {
  it('Ctrl+Enter 在输入框只触发发送，不再传播给编辑器的换行快捷键', async () => {
    render(<App />);
    const input = await screen.findByLabelText('接口路径');
    await act(async () => {});
    const editorShortcut = vi.fn();
    input.addEventListener('keydown', editorShortcut);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, repeat: true });
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(editorShortcut).not.toHaveBeenCalled();
  });
  it('中文输入法正在组合输入时，不触发发送', async () => {
    render(<App />);
    const input = await screen.findByLabelText('接口路径');
    await act(async () => {});
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(api.preview).not.toHaveBeenCalled();
  });
});
