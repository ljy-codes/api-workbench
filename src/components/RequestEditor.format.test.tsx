import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbench } from '../hooks/useWorkbench';
import { api } from '../lib/ipc';
import { demoWorkspace } from '../lib/workspace';
import { RequestEditor } from './RequestEditor';

vi.mock('../lib/ipc', () => ({
  desktop: true,
  api: { load: vi.fn(), save: vi.fn(), send: vi.fn(), loadResponse: vi.fn() },
}));

function Harness() {
  const model = useWorkbench();
  return <>
    <RequestEditor model={model} />
    <output aria-label="当前正文">{model.request?.body}</output>
    <output role="status" aria-label="格式化提示">{model.notice}</output>
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.loadResponse).mockResolvedValue(null);
});
afterEach(cleanup);

async function openBody(body: string) {
  const workspace = demoWorkspace();
  workspace.requests[0] = { ...workspace.requests[0], bodyType: 'json', body };
  vi.mocked(api.load).mockResolvedValue(workspace);
  render(<Harness />);
  await screen.findByLabelText('请求正文');
}

it('主动格式化才移除 null 并清理尾随逗号，不保存或发送请求', async () => {
  const body = '{"approveId":3370,"serviceId":1000002,"user":null,"nested":{"a":null,},"items":[null,],}';
  await openBody(body);
  expect(screen.getByLabelText('当前正文').textContent).toBe(body);
  fireEvent.click(screen.getByRole('button', { name: '格式化 JSON' }));
  await waitFor(() => expect(screen.getByLabelText('当前正文').textContent).toBe('{\n  "approveId": 3370,\n  "serviceId": 1000002,\n  "nested": {},\n  "items": [\n    null\n  ]\n}'));
  expect(api.save).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
});

it('非法 JSON 格式化失败时保留原始草稿', async () => {
  const body = '{"approveId":3370,,"user":null}';
  await openBody(body);
  fireEvent.click(screen.getByRole('button', { name: '格式化 JSON' }));
  expect(screen.getByLabelText('当前正文').textContent).toBe(body);
  expect(screen.getByRole('status', { name: '格式化提示' }).textContent).toContain('JSON 格式无效');
});
