import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbench } from '../hooks/useWorkbench';
import { api } from '../lib/ipc';
import { demoWorkspace } from '../lib/workspace';
import { ExchangePanel } from './ExchangePanel';

vi.mock('../lib/ipc', () => ({ desktop: true, api: {
  load: vi.fn(), loadResponse: vi.fn(), save: vi.fn(), send: vi.fn(), preview: vi.fn(),
} }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  vi.resetAllMocks();
  const w = demoWorkspace();
  w.requests[0].environmentConfigs = { 'demo-prod': {
    query: [], headers: [], bodyType: 'json', body: '{"production":"keep"}', timeoutMs: 4321,
    auth: { kind: 'bearer', token: '{{prod_token}}' },
  } };
  vi.mocked(api.load).mockResolvedValue(w);
  vi.mocked(api.loadResponse).mockResolvedValue(null);
});
afterEach(cleanup);
const text = JSON.stringify({ openapi: '3.1.0', info: { title: 'API', version: '1' }, paths: {
  '/users': { get: { summary: 'Document users', parameters: [
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
  ], responses: { 200: { description: 'ok' } } } },
} });

function Harness() {
  const model = useWorkbench();
  return <>
    <ExchangePanel model={model} />
    <output aria-label="workspace">{JSON.stringify(model.workspace)}</output>
    <output aria-label="notice">{model.notice}</output>
    <output aria-label="dirty">{String(model.dirty)}</output>
    <button onClick={() => model.mutate(w => ({ ...w, requests: w.requests.map(r => r.id === 'demo-list' ? { ...r, body: 'new local body' } : r) }))}>模拟本地编辑</button>
  </>;
}
async function open() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText('workspace').textContent).toContain('demo-list'));
  fireEvent.click(screen.getByRole('button', { name: 'OpenAPI 导入 / 更新' }));
  return screen.findByRole('dialog', { name: 'OpenAPI 导入与更新' });
}
const state = () => JSON.parse(screen.getByLabelText('workspace').textContent!);

describe('OpenAPI 预览确认闭环', () => {
  it('首次打开异步加载弹窗，等待期间显示状态并禁止重复点击入口', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText('workspace').textContent).toContain('demo-list'));
    const entry = screen.getByRole('button', { name: 'OpenAPI 导入 / 更新' });
    fireEvent.click(entry);
    expect(screen.getByText('正在加载 OpenAPI 导入工具…')).toBeTruthy();
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole('dialog', { name: 'OpenAPI 导入与更新' });
  });

  it('入口可打开，新项目预览不修改草稿，确认后只进入 model 未保存变更，不发送或保存', async () => {
    const dialog = await open(), before = state();
    fireEvent.change(within(dialog).getByLabelText('OpenAPI 文档'), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览变更' }));
    expect(state()).toEqual(before);
    expect(within(dialog).getByText('新增')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认所选为草稿' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state().projects).toHaveLength(2);
    expect(state().requests).toHaveLength(3);
    expect(screen.getByLabelText('dirty').textContent).toBe('true');
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('更新选定项目服务，显示准确补齐字段与保留策略，只在勾选并确认后更新且保留 env', async () => {
    const dialog = await open(), before = state();
    fireEvent.change(within(dialog).getByLabelText('导入方式'), { target: { value: 'update' } });
    expect((within(dialog).getByLabelText('目标服务') as HTMLSelectElement).value).toBe('demo-users');
    fireEvent.change(within(dialog).getByLabelText('OpenAPI 文档'), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览变更' }));
    expect(within(dialog).getByText(/补齐 Query：limit/)).toBeTruthy();
    expect(within(dialog).getByText(/所有 environmentConfigs 原样保留/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: '确认所选为草稿' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const removed = within(dialog).getByRole('checkbox', { name: /POST \/users/ });
    expect((removed as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'GET /users' }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state().requests).toHaveLength(2);
    expect(state().requests[0].query).toEqual([...before.requests[0].query, expect.objectContaining({ key: 'limit', value: '20' })]);
    expect(state().requests[0].environmentConfigs).toEqual(before.requests[0].environmentConfigs);
    expect(state().bindings).toEqual(before.bindings);
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('预览后本地修改即禁止确认，重新预览后仍保留新正文', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('导入方式'), { target: { value: 'update' } });
    fireEvent.change(within(dialog).getByLabelText('OpenAPI 文档'), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览变更' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'GET /users' }));
    fireEvent.click(screen.getByRole('button', { name: '模拟本地编辑' }));
    expect((within(dialog).getByRole('button', { name: '确认所选为草稿' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toMatch(/变更|过期/);
    expect(state().requests[0].body).toBe('new local body');
  });

  it('编辑文本/切换目标使预览失效，非法输入提示错误，不产生变更', async () => {
    const dialog = await open(), before = state();
    const editor = within(dialog).getByLabelText('OpenAPI 文档');
    fireEvent.change(editor, { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: '预览变更' }));
    fireEvent.change(editor, { target: { value: 'not openapi' } });
    expect(within(dialog).queryByRole('button', { name: '确认所选为草稿' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '预览变更' }));
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(state()).toEqual(before);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('超限文件读取前拒绝，避免占用解析内存', async () => {
    const dialog = await open(), file = new File(['{}'], 'large.yaml');
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    const read = vi.fn();
    Object.defineProperty(file, 'text', { value: read });
    fireEvent.change(within(dialog).getByLabelText('选择 JSON/YAML 文件'), { target: { files: [file] } });
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('10 MiB'));
    expect(read).not.toHaveBeenCalled();
  });

  it('新建导入保留加载后新增的同地址普通变量及旧项目完整配置，并选择新接口草稿', async () => {
    let current: ReturnType<typeof useWorkbench> | undefined;
    function Hook() { current = useWorkbench(); return null; }
    render(<Hook />);
    await waitFor(() => expect(current!.loading).toBe(false));
    act(() => current!.mutate(w => ({ ...w, variables: [...w.variables, {
      id: 'local-origin', projectId: 'demo-project', scope: 'environment',
      ownerId: 'demo-dev', name: 'origin', value: 'https://api.example.com/v1', isSecret: false,
    }] })));
    const before = structuredClone(current!.workspace);
    expect(before.variables).toContainEqual(expect.objectContaining({ id: 'local-origin' }));
    const { parseOpenApi, previewOpenApi } = await import('../lib/openapi');
    const plan = previewOpenApi(current!.workspace, parseOpenApi(text));
    await act(async () => {
      expect(await current!.applyOpenApi(plan, [plan.rows[0].key])).toBe(true);
    });
    const next = current!.workspace;
    for (const key of ['projects', 'environments', 'services', 'bindings', 'folders', 'requests', 'variables'] as const) {
      const oldIds = new Set(before[key].map(item => item.id));
      expect(next[key].filter(item => oldIds.has(item.id)), key).toEqual(before[key]);
    }
    expect(next.activeProjectId).not.toBe(before.activeProjectId);
    expect(next.projects).toHaveLength(2);
    const selected = next.requests.find(r => r.id === current!.selectedId)!;
    expect(next.services.find(s => s.id === selected.serviceId)?.projectId).toBe(next.activeProjectId);
    expect(current!.openTabs).toContain(selected.id);
    expect(current!.dirty).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('并发确认锁与无效计划保护由真实 hook 执行', async () => {
    let current: ReturnType<typeof useWorkbench> | undefined;
    function Hook() { current = useWorkbench(); return null; }
    render(<Hook />);
    await waitFor(() => expect(current!.loading).toBe(false));
    const before = structuredClone(current!.workspace);
    await act(async () => { expect(await current!.applyOpenApi({ mode: 'new', rows: [], warnings: [] }, [])).toBe(false); });
    expect(current!.workspace).toEqual(before);
    expect(current!.notice).toContain('预览无效');
    expect(api.save).not.toHaveBeenCalled();
  });
});
