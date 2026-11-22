import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace, emptyWorkspace, newRequest } from './lib/workspace';
import { DEFAULT_PREFERENCES, updatePreferences } from './lib/preferences';

vi.mock('./lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  loadResponse: vi.fn(), saveResponse: vi.fn(),
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock('./components/CodeEditor', () => ({ default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) =>
  <textarea aria-label="代码编辑器" value={value} onChange={e => onChange?.(e.target.value)} /> }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  updatePreferences(DEFAULT_PREFERENCES);
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.save).mockImplementation(async w => ({ ...w, revision: w.revision + 1 }));
});
afterEach(cleanup);

async function home() {
  render(<App />);
  await screen.findByText('已保存');
  await waitFor(() => expect(screen.queryByText('正在加载本地工作区')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
  return within(screen.getByRole('region', { name: '项目仪表盘' }));
}

describe('仪表盘主页', () => {
  it('从环境矩阵点击 Logo 回到主页，显示当前页状态和真实统计', async () => {
    await home();
    fireEvent.click(screen.getByRole('button', { name: '环境矩阵' }));
    fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
    expect(screen.getByRole('button', { name: '返回主页' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: '项目概览' })).toBeVisible();
    const stats = within(screen.getByRole('list', { name: '项目统计' }));
    expect(stats.getByLabelText('接口总数')).toHaveTextContent('2');
    expect(stats.getByLabelText('服务总数')).toHaveTextContent('2');
    expect(stats.getByLabelText('环境总数')).toHaveTextContent('2');
    expect(stats.getByLabelText('目录总数')).toHaveTextContent('1');
    expect(within(screen.getByRole('region', { name: '请求方法分布' })).getByText('GET')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '请求方法分布' })).getByText('POST')).toBeVisible();
  });

  it('统计与已打开接口只包含当前项目，切换项目立即更新', async () => {
    const w = demoWorkspace();
    w.projects.push({ id: 'other', name: '隔离项目', activeEnvironmentId: 'other-env' });
    w.services.push({ id: 'other-service', projectId: 'other', name: '隔离服务' });
    w.environments.push({ id: 'other-env', projectId: 'other', name: '隔离环境', isProduction: false });
    w.requests.push({ ...newRequest('other-service', null, 'other-request'), name: '隔离接口' });
    vi.mocked(api.load).mockResolvedValue(w);
    const dashboard = await home();
    expect(dashboard.queryByText('隔离服务')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: '当前项目' }));
    fireEvent.click(screen.getByRole('option', { name: '隔离项目' }));
    await waitFor(() => expect(dashboard.getByLabelText('接口总数')).toHaveTextContent('1'));
    expect(dashboard.getByText('隔离服务')).toBeVisible();
    expect(dashboard.queryByRole('button', { name: '继续调试 获取用户列表' })).toBeNull();
  });

  it('环境概览只计算已启用且有地址的当前项目服务绑定，并标识生产', async () => {
    const w = demoWorkspace();
    w.bindings.push(
      { id: 'disabled', projectId: 'demo-project', serviceId: 'demo-orders', environmentId: 'demo-dev', baseUrl: 'https://disabled.test', enabled: false },
      { id: 'blank', projectId: 'demo-project', serviceId: 'demo-users', environmentId: 'demo-prod', baseUrl: '  ', enabled: true },
    );
    vi.mocked(api.load).mockResolvedValue(w);
    await home();
    const environments = within(screen.getByRole('region', { name: '环境概览' }));
    expect(environments.getByLabelText('开发环境配置覆盖')).toHaveTextContent('1 / 2');
    expect(environments.getByLabelText('生产环境配置覆盖')).toHaveTextContent('0 / 2');
    expect(environments.getByText('生产')).toBeVisible();
    expect(environments.queryByText(/在线|健康/)).toBeNull();
  });

  it('往返主页保留环境、接口草稿和标签，不触发保存或发送', async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('参数值1'), { target: { value: '主页往返草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续调试 获取用户列表' }));
    expect(await screen.findByLabelText('参数值1')).toHaveValue('主页往返草稿');
    expect(screen.getByRole('combobox', { name: '当前环境' })).toHaveTextContent('开发环境');
    expect(within(screen.getByRole('tablist', { name: '接口标签' })).getAllByRole('tab')).toHaveLength(1);
    expect(api.save).not.toHaveBeenCalled();
  });

  it('主页 Ctrl+Enter 不发送，Ctrl+S 仍可保存草稿', async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('接口路径'), { target: { value: '/dashboard-draft' } });
    fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.save).mock.calls[0][0].requests[0].path).toBe('/dashboard-draft');
  });

  it('返回主页期间请求继续执行，回到工作台显示原请求的响应', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.send>>) => void;
    vi.mocked(api.preview).mockResolvedValue({ url: 'https://api.example.com/users', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [] });
    vi.mocked(api.send).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '发送请求' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '返回主页' }));
    expect(api.cancel).not.toHaveBeenCalled();
    const input = vi.mocked(api.send).mock.calls[0][0];
    await act(async () => finish({ executionId: input.executionId, status: 200, statusText: 'OK', durationMs: 25, sizeBytes: 2, body: '{}', headers: [], truncated: false, environmentName: '开发环境', url: 'https://api.example.com/users' }));
    fireEvent.click(screen.getByRole('button', { name: '继续调试 获取用户列表' }));
    expect(await screen.findByText('200 OK')).toBeVisible();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.saveResponse).toHaveBeenCalledWith('demo-list', 'demo-dev', expect.objectContaining({ executionId: input.executionId }));
  });

  it('主页新建接口复用原对话框，默认选中当前接口服务', async () => {
    const dashboard = await home();
    fireEvent.click(dashboard.getByRole('button', { name: '新建接口' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建接口' }));
    expect(dialog.getByLabelText('所属服务')).toHaveValue('demo-users');
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '主页新接口' } });
    fireEvent.click(dialog.getByRole('button', { name: '应用到工作区' }));
    expect(screen.getByLabelText('接口总数')).toHaveTextContent('3');
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it.each([
    ['配置环境', '一份接口，连接不同环境'],
    ['管理变量', '配置一次，在合适的范围生效'],
    ['管理工作区', '有条理地组织每一个接口'],
  ])('主页快捷入口 %s 可到达现有页面', async (name, heading) => {
    const dashboard = await home();
    fireEvent.click(dashboard.getByRole('button', { name }));
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    expect(screen.getByRole('button', { name: '返回主页' })).not.toHaveAttribute('aria-current');
  });

  it('空工作区提供创建项目入口，创建后更新统计且不自动联网', async () => {
    vi.mocked(api.load).mockResolvedValue(emptyWorkspace());
    const dashboard = await home();
    expect(dashboard.getByRole('heading', { name: '创建你的第一个项目' })).toBeVisible();
    fireEvent.click(dashboard.getByRole('button', { name: '新建项目' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }));
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '仪表盘项目' } });
    fireEvent.click(dialog.getByRole('button', { name: '应用到工作区' }));
    expect(screen.getByRole('heading', { name: '项目概览' })).toBeVisible();
    expect(screen.getByLabelText('接口总数')).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: '新建服务' })).toBeVisible();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('没有已打开标签时给出入口，服务为空时显示明确空状态', async () => {
    const w = demoWorkspace();
    w.requests = [];
    w.folders = [];
    w.services = [];
    w.bindings = [];
    vi.mocked(api.load).mockResolvedValue(w);
    const dashboard = await home();
    expect(dashboard.getByText('还没有服务')).toBeVisible();
    expect(dashboard.getByText('还没有打开的接口')).toBeVisible();
    expect(dashboard.getByText('还没有接口数据')).toBeVisible();
    expect(dashboard.getByLabelText('开发环境配置覆盖')).toHaveTextContent('0 / 0');
    fireEvent.click(dashboard.getByRole('button', { name: '新建服务' }));
    expect(screen.getByRole('dialog', { name: '新建服务' })).toBeVisible();
  });
});
