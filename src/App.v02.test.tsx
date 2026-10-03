import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn(),
  exportCurl: vi.fn(), pickFile: vi.fn(), readProjectFile: vi.fn(), writeProjectFile: vi.fn(), backup: vi.fn(),
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.save).mockImplementation(async w => ({ ...w, revision: w.revision + 1 }));
  vi.mocked(api.preview).mockResolvedValue({ url: 'https://example.com', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [{ name: 'token', value: 'must-not-render', source: 'environment', isSecret: true }, { name: 'page', value: '3', source: 'request', isSecret: false }] });
});
afterEach(cleanup);

describe('0.2 前端联接', () => {
  it('管理页同 kind 的服务重排仍隔离鉴权，外部保存结果同步且不丢未完成输入', async () => {
    const workspace = demoWorkspace();
    workspace.services[0].auth = { kind: 'bearer', token: '{{users}}' };
    workspace.services[1].auth = { kind: 'bearer', token: '{{orders}}' };
    vi.mocked(api.load).mockResolvedValue(workspace);
    vi.mocked(api.save).mockImplementation(async w => ({
      ...w, revision: w.revision + 1,
      services: w.services.map(s => s.id === 'demo-users' ? { ...s, auth: { kind: 'bearer' as const, token: '{{external}}' } } : s).reverse(),
    }));
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    const details = screen.getByText('服务公共 Headers 与鉴权').parentElement!.querySelectorAll('details');
    const users = within(details[0]), orders = within(details[1]);
    fireEvent.click(users.getByText('用户服务'));
    fireEvent.click(orders.getByText('订单服务'));
    expect((users.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{users}}');
    expect((orders.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{orders}}');
    fireEvent.change(users.getByLabelText('Token 变量引用'), { target: { value: '{{unfinished' } });
    fireEvent.change(orders.getByLabelText('Token 变量引用'), { target: { value: '{{newOrders}}' } });
    expect((users.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{unfinished');
    fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
    await waitFor(() => expect((users.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{external}}'));
    expect((orders.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{newOrders}}');
    fireEvent.click(users.getByRole('button', { name: '恢复未完成输入' }));
    expect((users.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{unfinished');
    expect(vi.mocked(api.save).mock.calls[0][0].services[0].auth?.token).toBe('{{users}}');
  });
  it('请求同 kind 切换不泄露上一接口的凭据引用', async () => {
    const workspace = demoWorkspace();
    workspace.requests[0].auth = { kind: 'bearer', token: '{{first}}' };
    workspace.requests[1].auth = { kind: 'bearer', token: '{{second}}' };
    vi.mocked(api.load).mockResolvedValue(workspace);
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: '鉴权' }));
    expect((screen.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{first}}');
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: /创建用户/ }));
    expect((screen.getByLabelText('Token 变量引用') as HTMLInputElement).value).toBe('{{second}}');
  });
  it('真实 cURL 解析从对话框导入到当前环境，只生成草稿和新标签', async () => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    fireEvent.click(screen.getByRole('button', { name: '导入 cURL' }));
    const dialog = screen.getByRole('dialog', { name: '导入 cURL' });
    fireEvent.change(within(dialog).getByLabelText('新服务名称（可选）'), { target: { value: '导入测试服务' } });
    fireEvent.change(within(dialog).getByLabelText('cURL 命令'), { target: { value: "curl 'https://example.com/imported?page=2'" } });
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为草稿' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入 cURL' })).toBeNull());
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '接口工作台' }));
    expect((screen.getByLabelText('接口路径') as HTMLInputElement).value).toBe('/imported');
    expect(within(screen.getByRole('tablist', { name: '接口标签' })).getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.save).mock.calls[0][0];
    const service = saved.services.find(s => s.name === '导入测试服务')!;
    expect(saved.bindings).toContainEqual(expect.objectContaining({ serviceId: service.id, environmentId: 'demo-dev' }));
  });
  it('项目导入错误在当前对话框内可见，保留输入方便修正', async () => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    fireEvent.click(screen.getByRole('button', { name: '粘贴项目 JSON' }));
    const dialog = screen.getByRole('dialog', { name: '粘贴项目 JSON' });
    fireEvent.change(within(dialog).getByLabelText('项目 JSON'), { target: { value: 'invalid' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为草稿' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect((within(dialog).getByLabelText('项目 JSON') as HTMLTextAreaElement).value).toBe('invalid');
    expect(api.save).not.toHaveBeenCalled();
  });
  it('关闭当前标签再从侧栏打开，Query 草稿保持不变', async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('参数值1'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭标签 获取用户列表' }));
    expect(screen.queryByLabelText('参数值1')).toBeNull();
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: /获取用户列表/ }));
    fireEvent.click(await screen.findByRole('button', { name: '保留草稿并切换' }));
    expect((await screen.findByLabelText('参数值1') as HTMLInputElement).value).toBe('99');
  });
  it('服务公共 Header 和 API Key 引用进入保存快照，不改变请求继承', async () => {
    render(<App />);
    await screen.findByLabelText('接口路径');
    fireEvent.click(screen.getByRole('button', { name: '工作区管理' }));
    const details = screen.getByText('服务公共 Headers 与鉴权').parentElement!.querySelector('details')!;
    fireEvent.click(within(details).getByText('用户服务'));
    fireEvent.click(within(details).getByRole('button', { name: '添加公共请求头' }));
    fireEvent.change(within(details).getByLabelText('公共请求头名称1'), { target: { value: 'X-Client' } });
    fireEvent.change(within(details).getByLabelText('公共请求头值1'), { target: { value: '{{client}}' } });
    fireEvent.change(within(details).getByLabelText('鉴权方式'), { target: { value: 'apiKey' } });
    fireEvent.change(within(details).getByLabelText('API Key 名称'), { target: { value: 'X-Key' } });
    fireEvent.change(within(details).getByLabelText('API Key 变量引用'), { target: { value: '{{apiKey}}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.save).mock.calls[0][0];
    expect(saved.services[0].headers?.[0]).toMatchObject({ key: 'X-Client', value: '{{client}}' });
    expect(saved.services[0].auth).toMatchObject({ kind: 'apiKey', value: '{{apiKey}}', location: 'header' });
    expect(saved.requests[0].auth).toBeUndefined();
  });
  it('原生预览显示变量来源但不显示秘密解析值', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '脱敏预览' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(screen.getByRole('tab', { name: '变量' }));
    expect(screen.getByText('environment')).toBeTruthy();
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.getByText('••••••')).toBeTruthy();
    expect(screen.queryByText('must-not-render')).toBeNull();
  });
  it('文件选择期间锁定编辑，取消不覆盖路径；切回 URL 编码禁用文件项', async () => {
    let finish!: (path: string | null) => void;
    vi.mocked(api.pickFile).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const w = demoWorkspace();
    w.requests[0] = { ...w.requests[0], bodyType: 'multipart', form: [{ id: 'f', key: 'file', kind: 'file', value: 'C:\\old.txt', enabled: true }] };
    vi.mocked(api.load).mockResolvedValue(w);
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Body' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件1' }));
    await waitFor(() => expect(api.pickFile).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('接口路径').matches(':disabled')).toBe(true);
    await act(async () => finish(null));
    expect((screen.getByLabelText('表单值1') as HTMLInputElement).value).toBe('C:\\old.txt');
    fireEvent.change(screen.getByLabelText('正文类型'), { target: { value: 'form' } });
    expect((screen.getByLabelText('启用表单项1') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('启用表单项1').matches(':disabled')).toBe(true);
  });
});
