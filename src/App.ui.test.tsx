import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Workbench, Execution } from './hooks/useWorkbench';
import { demoWorkspace } from './lib/workspace';

const state = vi.hoisted(() => ({ model: {} as Workbench }));
vi.mock('./hooks/useWorkbench', () => ({ useWorkbench: () => state.model }));
vi.mock('./hooks/useNativeClose', () => ({ useNativeClose: vi.fn() }));
vi.mock('./lib/ipc', () => ({ desktop: true }));
vi.mock('./components/RequestEditor', () => ({
  RequestEditor: () => {
    const [value, setValue] = useState('');
    return <input aria-label="编辑器局部草稿" value={value} onChange={e => setValue(e.target.value)} />;
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  const workspace = demoWorkspace();
  const execution: Execution = { id: 'latest', requestId: 'demo-list', requestName: '列表', environment: '开发环境', running: false,
    response: { executionId: 'latest', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 2, body: '{}', headers: [], truncated: false, environmentName: '开发环境', url: 'https://example.test' } };
  state.model = {
    workspace, project: workspace.projects[0], environment: workspace.environments[0], request: workspace.requests[0],
    selectedId: 'demo-list', openTabs: ['demo-list'], loading: false, busy: false, dirty: false, hasRunning: false,
    execution, notice: '', confirmation: null, temporary: [], preview: null,
    save: vi.fn().mockResolvedValue(true), execute: vi.fn(), selectProject: vi.fn(), selectEnvironment: vi.fn(),
    selectRequest: vi.fn(), setNotice: vi.fn(), setConfirmation: vi.fn(), closeTab: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true), cleanData: vi.fn().mockResolvedValue(true), clearResponse: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
  } as unknown as Workbench;
});
afterEach(cleanup);

describe('颜色、快捷键和环境 UI 边界', () => {
  it('项目环境使用自定义组合框且生产标识不依赖颜色', () => {
    render(<App />);
    const project = screen.getByRole('combobox', { name: '当前项目' });
    expect(project.tagName).toBe('BUTTON');
    expect(project.querySelector('.color-dot')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: '当前环境' }));
    fireEvent.click(screen.getByRole('option', { name: /生产环境.*生产/ }));
    expect(state.model.selectEnvironment).toHaveBeenCalledWith('demo-prod');
  });
  it.each([{ ctrlKey: true, key: 's' }, { metaKey: true, key: 'S' }])('捕获保存快捷键 %j，阻止浏览器及编辑器处理', shortcut => {
    render(<App />);
    const input = screen.getByLabelText('编辑器局部草稿');
    const childHandler = vi.fn();
    input.addEventListener('keydown', childHandler);
    const event = new KeyboardEvent('keydown', { ...shortcut, bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(childHandler).not.toHaveBeenCalled();
    expect(state.model.save).toHaveBeenCalledTimes(1);
  });
  it.each([{ repeat: true }, { isComposing: true }])('忽略快捷键事件 %j', extra => {
    render(<App />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, ...extra });
    expect(state.model.save).not.toHaveBeenCalled();
  });
  it('对话框打开时 Ctrl+S 不保存但仍阻止浏览器', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => screen.getByLabelText('名称').dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(state.model.save).not.toHaveBeenCalled();
  });
  it.each(['busy', 'loading'] as const)('%s 时保存快捷键不调用模型', flag => {
    state.model[flag] = true;
    render(<App />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(state.model.save).not.toHaveBeenCalled();
  });
  it('保留 Ctrl+Enter 发送，保存状态为已保存', () => {
    render(<App />);
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(screen.queryByText('已同步')).toBeNull();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(state.model.execute).toHaveBeenCalledTimes(1);
  });
  it('清除当前响应连接模型', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '清除当前响应' }));
    expect(state.model.clearResponse).toHaveBeenCalledTimes(1);
  });
  it('相同请求和 execution id 切换环境重置编辑器及响应局部状态', () => {
    const { rerender } = render(<App />);
    fireEvent.change(screen.getByLabelText('编辑器局部草稿'), { target: { value: '旧环境临时输入' } });
    fireEvent.change(screen.getByLabelText('搜索响应正文'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    state.model = { ...state.model, environment: state.model.workspace.environments[1] };
    rerender(<App />);
    expect((screen.getByLabelText('编辑器局部草稿') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('搜索响应正文') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('响应显示格式') as HTMLSelectElement).value).toBe('json');
  });
  it('管理页提供维护入口，默认确认全部项目环境响应', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    const panel = screen.getByRole('region', { name: '数据清理' });
    expect(within(panel).getByText(/64 MiB/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '清理数据' }));
    await act(async () => {});
    expect(state.model.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/所有项目.*所有环境/), danger: true }));
    expect(state.model.cleanData).toHaveBeenCalledWith(false);
  });
});
