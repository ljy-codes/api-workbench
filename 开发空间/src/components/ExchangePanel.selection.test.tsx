import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workbench } from '../hooks/useWorkbench';
import { demoWorkspace } from '../lib/workspace';
import { exportProject } from '../lib/exchange';
import { ExchangePanel } from './ExchangePanel';
import { Dialog } from './Dialog';

vi.mock('../lib/ipc', () => ({ desktop: true }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);
function model() {
  const workspace = demoWorkspace();
  return {
    workspace, project: workspace.projects[0], environment: workspace.environments[0],
    busy: false, loading: false, notice: '', readTransferFile: vi.fn().mockResolvedValue(null),
    importSelected: vi.fn().mockResolvedValue(true), writeSelected: vi.fn().mockResolvedValue(true),
    importCurlText: vi.fn().mockResolvedValue(true),
  } as unknown as Workbench;
}
describe('导入导出选择交互', () => {
  it('预览只解析，用户确认后才导入勾选环境', async () => {
    const value = model();
    render(<ExchangePanel model={value} />);
    fireEvent.click(screen.getByRole('button', { name: '粘贴项目 JSON' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('项目 JSON'), { target: { value: exportProject(value.workspace, value.project!.id) } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览内容' }));
    const prod = await within(dialog).findByRole('checkbox', { name: /生产环境/ });
    expect(value.importSelected).not.toHaveBeenCalled();
    fireEvent.click(prod);
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为草稿' }));
    await waitFor(() => expect(value.importSelected).toHaveBeenCalledTimes(1));
    const [bundle, selection] = vi.mocked(value.importSelected).mock.calls[0];
    const project = bundle.workspace.projects[0];
    expect(selection[project.id]).toHaveLength(1);
    expect(selection[project.id]).toContain(bundle.workspace.environments.find(env => env.name === '开发环境')!.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('导出可取消环境、取消项目，未选任何项目时禁止提交', async () => {
    const value = model();
    render(<ExchangePanel model={value} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /生产环境/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '导出所选内容' }));
    await waitFor(() => expect(value.writeSelected).toHaveBeenCalledWith({ 'demo-project': ['demo-dev'] }));
  });
  it('原生文件选择取消不打开预览，不改变工作区', async () => {
    const value = model();
    render(<ExchangePanel model={value} />);
    fireEvent.click(screen.getByRole('button', { name: '从文件导入' }));
    await act(async () => {});
    expect(value.readTransferFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(value.importSelected).not.toHaveBeenCalled();
  });
  it('取消原生导出后保留当前勾选，可再次提交且不显示错误', async () => {
    const value = model();
    vi.mocked(value.writeSelected).mockResolvedValue(null);
    render(<ExchangePanel model={value} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /生产环境/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '导出所选内容' }));
    await waitFor(() => expect(value.writeSelected).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '导出所选内容' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((within(dialog).getByRole('checkbox', { name: /生产环境/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
  it.each([false, true])('内层 Escape 不传播给外层设置，busy=%s', busy => {
    const value = model(), outerClose = vi.fn();
    const content = () => <Dialog title="外层设置" onClose={outerClose}><ExchangePanel model={value} /></Dialog>;
    const view = render(content());
    fireEvent.click(screen.getByRole('button', { name: '粘贴项目 JSON' }));
    const inner = screen.getByRole('dialog', { name: '粘贴项目 JSON' });
    value.busy = busy;
    view.rerender(content());
    fireEvent(inner, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(outerClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '粘贴项目 JSON' }) !== null).toBe(busy);
  });
});
