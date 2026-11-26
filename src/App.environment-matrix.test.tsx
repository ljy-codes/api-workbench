import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './lib/ipc';
import { demoWorkspace } from './lib/workspace';
import type { Workspace } from './types';

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
  vi.mocked(api.load).mockResolvedValue(demoWorkspace());
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.save).mockImplementation(async workspace => ({ ...workspace, revision: workspace.revision + 1 }));
});
afterEach(cleanup);

async function openMatrix() {
  const view = render(<App />);
  await waitFor(() => expect(screen.queryByText('正在加载本地工作区')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '环境矩阵' }));
  return view;
}
const matrix = () => within(screen.getByRole('table'));
const serviceOrder = () => matrix().getAllByRole('rowheader').map(header => header.textContent);
const environmentOrder = () => matrix().getAllByRole('columnheader').slice(1).map(header => header.textContent);

it('服务可以上下移动，环境可以左右移动，首尾禁止越界', async () => {
  await openMatrix();
  expect(serviceOrder()).toEqual(['用户服务', '订单服务']);
  expect(environmentOrder()).toEqual(['开发环境', '生产环境生产']);
  expect(screen.getByRole('button', { name: '上移服务 用户服务' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下移服务 订单服务' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '左移环境 开发环境' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '右移环境 生产环境' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '右移环境 开发环境' }));
  expect(serviceOrder()).toEqual(['订单服务', '用户服务']);
  expect(environmentOrder()).toEqual(['生产环境生产', '开发环境']);
  expect(screen.getByRole('button', { name: '上移服务 订单服务' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '左移环境 生产环境' })).toBeDisabled();
  expect(screen.getByText('未保存修改')).toBeVisible();
  expect(api.save).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '上移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '左移环境 开发环境' }));
  expect(serviceOrder()).toEqual(['用户服务', '订单服务']);
  expect(environmentOrder()).toEqual(['开发环境', '生产环境生产']);
});

it('连续调序只交换当前项目槽位，不修改其他项目、绑定或选中环境', async () => {
  const w = demoWorkspace();
  w.projects.push({ id: 'other', name: '其他项目', activeEnvironmentId: 'other-dev' });
  w.services.splice(1, 0, { id: 'other-service', projectId: 'other', name: '其他服务' });
  w.environments.splice(1, 0, { id: 'other-dev', projectId: 'other', name: '其他环境', isProduction: false });
  w.services.push({ id: 'demo-search', projectId: 'demo-project', name: '搜索服务' });
  w.environments.push({ id: 'demo-test', projectId: 'demo-project', name: '测试环境', isProduction: false });
  vi.mocked(api.load).mockResolvedValue(w);
  const original = structuredClone(w);
  await openMatrix();
  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '右移环境 开发环境' }));
  fireEvent.click(screen.getByRole('button', { name: '右移环境 开发环境' }));
  expect(serviceOrder()).toEqual(['订单服务', '搜索服务', '用户服务']);
  expect(environmentOrder()).toEqual(['生产环境生产', '测试环境', '开发环境']);
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByText('已保存')).toBeVisible());
  const saved = vi.mocked(api.save).mock.calls[0][0];
  expect(saved.services.map(s => s.id)).toEqual(['demo-orders', 'other-service', 'demo-search', 'demo-users']);
  expect(saved.environments.map(e => e.id)).toEqual(['demo-prod', 'other-dev', 'demo-test', 'demo-dev']);
  expect({ ...saved, services: original.services, environments: original.environments }).toEqual(original);
  expect(w).toEqual(original);
  expect(screen.getByRole('combobox', { name: '当前环境' })).toHaveTextContent('开发环境');
});

it('调序后仍编辑对应服务和环境的绑定，启用状态与其他地址保留', async () => {
  const w = demoWorkspace();
  w.bindings.push({ id: 'orders-prod', projectId: 'demo-project', serviceId: 'demo-orders', environmentId: 'demo-prod', baseUrl: 'https://orders.example.com', enabled: false });
  vi.mocked(api.load).mockResolvedValue(w);
  await openMatrix();
  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '右移环境 开发环境' }));
  fireEvent.change(screen.getByLabelText('用户服务 开发环境 基础地址'), { target: { value: 'https://users.example.com/v2' } });
  fireEvent.change(screen.getByLabelText('订单服务 开发环境 基础地址'), { target: { value: 'https://orders-dev.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByText('已保存')).toBeVisible());
  const saved = vi.mocked(api.save).mock.calls[0][0];
  expect(saved.bindings).toEqual([
    { ...w.bindings[0], baseUrl: 'https://users.example.com/v2' },
    w.bindings[1],
    expect.objectContaining({ serviceId: 'demo-orders', environmentId: 'demo-dev', baseUrl: 'https://orders-dev.example.com', enabled: true }),
  ]);
});

it('保存重载后保持顺序，侧栏和环境下拉使用同一顺序', async () => {
  let persisted: Workspace = demoWorkspace();
  vi.mocked(api.load).mockImplementation(async () => structuredClone(persisted));
  vi.mocked(api.save).mockImplementation(async w => {
    persisted = structuredClone({ ...w, revision: w.revision + 1 });
    return structuredClone(persisted);
  });
  const view = await openMatrix();
  fireEvent.click(screen.getByRole('button', { name: '上移服务 订单服务' }));
  fireEvent.click(screen.getByRole('button', { name: '左移环境 生产环境' }));
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByText('已保存')).toBeVisible());
  view.unmount();
  await openMatrix();
  expect(serviceOrder()).toEqual(['订单服务', '用户服务']);
  expect(environmentOrder()).toEqual(['生产环境生产', '开发环境']);
  const sidebarServices = screen.getAllByRole('button', { name: /^(订单服务|用户服务)/ });
  expect(sidebarServices.map(button => button.textContent)).toEqual(['订单服务0', '用户服务2']);
  fireEvent.click(screen.getByRole('combobox', { name: '当前环境' }));
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['请选择环境', '生产环境生产', '开发环境']);
});

it('保存失败保留排序草稿，重试成功后清除未保存标记', async () => {
  vi.mocked(api.save).mockRejectedValueOnce(new Error('磁盘只读'));
  await openMatrix();
  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '右移环境 开发环境' }));
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('磁盘只读'));
  expect(serviceOrder()).toEqual(['订单服务', '用户服务']);
  expect(environmentOrder()).toEqual(['生产环境生产', '开发环境']);
  expect(screen.getByText('未保存修改')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  await waitFor(() => expect(screen.getByText('已保存')).toBeVisible());
  expect(vi.mocked(api.save).mock.calls[1][0]).toEqual(vi.mocked(api.save).mock.calls[0][0]);
});

it('保存进行中禁止调序，完成后恢复', async () => {
  let complete!: () => void;
  vi.mocked(api.save).mockImplementation(w => new Promise(resolve => { complete = () => resolve({ ...w, revision: w.revision + 1 }); }));
  await openMatrix();
  fireEvent.click(screen.getByRole('button', { name: '下移服务 用户服务' }));
  fireEvent.click(screen.getByRole('button', { name: '保存全部修改' }));
  const move = screen.getByRole('button', { name: '下移服务 订单服务' });
  expect(move).toBeDisabled();
  fireEvent.click(move);
  expect(serviceOrder()).toEqual(['订单服务', '用户服务']);
  await act(async () => complete());
  expect(move).toBeEnabled();
});
