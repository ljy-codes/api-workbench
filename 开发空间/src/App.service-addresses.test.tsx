import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace } from './lib/workspace';

vi.mock('./lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), save: vi.fn(), loadResponse: vi.fn(), saveResponse: vi.fn(),
} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async () => () => {}, destroy: vi.fn(),
}) }));
vi.mock('./components/CodeEditor', () => ({ default: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  const w = demoWorkspace();
  w.variables.push(
    { id: 'old-host', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'apiRoot', value: w.bindings[0].baseUrl, isSecret: false },
    { id: 'business', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'tenantId', value: '42', isSecret: false },
  );
  vi.mocked(api.load).mockResolvedValue(w);
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.save).mockImplementation(async workspace => ({ ...workspace, revision: workspace.revision + 1 }));
});
afterEach(cleanup);

async function environmentVariables() {
  render(<App />);
  await waitFor(() => expect(screen.queryByText('正在加载本地工作区')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '变量配置' }));
  fireEvent.click(screen.getByRole('tab', { name: /3.*环境/ }));
}

it('旧工作区移除无引用的重复地址，普通环境变量保留且不自动写数据库', async () => {
  await environmentVariables();
  expect(screen.queryByDisplayValue('apiRoot')).toBeNull();
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
  expect(screen.getByText('未保存修改')).toBeVisible();
  expect(api.save).not.toHaveBeenCalled();
  expect((await vi.mocked(api.load).mock.results[0].value).variables.some((v: { id: string }) => v.id === 'old-host')).toBe(true);
});

it('从变量页进入唯一地址维护入口，修改地址后切回变量页不残留旧副本', async () => {
  await environmentVariables();
  fireEvent.click(screen.getByRole('button', { name: '配置服务地址' }));
  const address = screen.getByLabelText('用户服务 开发环境 基础地址');
  fireEvent.change(address, { target: { value: 'https://changed.example.com/v2' } });
  fireEvent.click(screen.getByRole('button', { name: '变量配置' }));
  fireEvent.click(screen.getByRole('tab', { name: /3.*环境/ }));
  expect(screen.queryByDisplayValue('apiRoot')).toBeNull();
  expect(screen.queryByDisplayValue('https://api.example.com/v1')).toBeNull();
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
});

it('被现有请求引用的地址变量保留并提示兼容原因', async () => {
  const w = demoWorkspace();
  w.variables = [{ id: 'old-host', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'apiRoot', value: w.bindings[0].baseUrl, isSecret: false }];
  w.requests[0].query.push({ id: 'legacy', key: 'origin', value: '{{apiRoot}}', enabled: true });
  vi.mocked(api.load).mockResolvedValue(w);
  await environmentVariables();
  expect(screen.getByDisplayValue('apiRoot')).toBeVisible();
  expect(screen.getByText(/地址变量仍被模板引用/)).toBeVisible();
});

it('重复配置合并后保存失败，保留统一后的草稿和原有环境变量', async () => {
  vi.mocked(api.save).mockRejectedValue(new Error('磁盘只读'));
  await environmentVariables();
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('磁盘只读'));
  expect(screen.queryByDisplayValue('apiRoot')).toBeNull();
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
  expect(screen.getByText('未保存修改')).toBeVisible();
});

it('环境变量编辑为重复地址后，在焦点离开整行时合并', async () => {
  await environmentVariables();
  const value = screen.getByLabelText('tenantId的值');
  fireEvent.change(value, { target: { value: 'https://api.example.com/v1' } });
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
  fireEvent.blur(value, { relatedTarget: screen.getByRole('button', { name: '配置服务地址' }) });
  expect(screen.queryByDisplayValue('tenantId')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('无引用的重复地址已合并');
});

it('行内移动焦点不合并，勾选秘密值后离开也保留', async () => {
  await environmentVariables();
  const value = screen.getByLabelText('tenantId的值');
  const checkbox = within(value.closest('.variable-row') as HTMLElement).getByRole('checkbox');
  fireEvent.change(value, { target: { value: 'https://api.example.com/v1' } });
  fireEvent.blur(value, { relatedTarget: checkbox });
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
  fireEvent.click(checkbox);
  fireEvent.blur(checkbox, { relatedTarget: screen.getByRole('button', { name: '配置服务地址' }) });
  expect(screen.getByDisplayValue('tenantId')).toBeVisible();
  expect(screen.getByLabelText('tenantId的值')).toHaveAttribute('type', 'password');
});
