import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { foldEffect } from '@codemirror/language';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbench } from '../hooks/useWorkbench';
import { api } from '../lib/ipc';
import { demoWorkspace } from '../lib/workspace';
import type { RequestDefinition } from '../types';
import { RequestEditor } from './RequestEditor';

// Keep the workbench and CodeMirror real; only native IPC and the system clipboard
// cross the test environment boundary.
vi.mock('../lib/ipc', () => ({
  desktop: true,
  api: {
    load: vi.fn(), save: vi.fn(), send: vi.fn(), preview: vi.fn(),
    loadResponse: vi.fn(), saveResponse: vi.fn(),
  },
}));

function Harness() {
  const model = useWorkbench();
  return <>
    <fieldset disabled={model.busy}>
      <RequestEditor key={JSON.stringify([model.request?.id, model.environment?.id])} model={model} />
    </fieldset>
    <button onClick={() => model.selectEnvironment('demo-prod')}>切换到生产环境</button>
    <output aria-label="当前草稿">{model.request?.body}</output>
    <output aria-label="未保存修改">{String(model.dirty)}</output>
    <output role="status" aria-label="操作提示">{model.notice}</output>
  </>;
}

function loadBody(body: string, bodyType: RequestDefinition['bodyType'] = 'json') {
  const workspace = demoWorkspace();
  workspace.requests[0] = { ...workspace.requests[0], bodyType, body };
  vi.mocked(api.load).mockResolvedValue(workspace);
  return workspace;
}

beforeEach(() => {
  vi.clearAllMocks();
  userEvent.setup();
  vi.mocked(api.loadResponse).mockResolvedValue(null);
  vi.mocked(api.save).mockImplementation(async workspace => ({ ...workspace, revision: workspace.revision + 1 }));
  loadBody('{"saved":true}');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openEditor() {
  render(<Harness />);
  return EditorView.findFromDOM(await screen.findByLabelText('请求正文'))!;
}

it('复制当前 JSON 完整草稿，忽略选区和折叠，保持缩进、变量及未保存状态', async () => {
  const view = await openEditor();
  const draft = '{\n  "instanceId": "100082817",\n  "token": "{{accessToken}}"\n}\n';
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: draft },
      selection: { anchor: 4, head: 14 },
    });
  });
  act(() => { view.dispatch({ effects: foldEffect.of({ from: 1, to: draft.lastIndexOf('}') }) }); });
  fireEvent.click(screen.getByRole('button', { name: '复制请求体' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(draft));
  expect(screen.getByRole('status', { name: '操作提示' }).textContent).toContain('已复制');
  expect(view.state.doc.toString()).toBe(draft);
  expect(screen.getByLabelText('未保存修改').textContent).toBe('true');
  expect(api.save).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: /^Headers/ }));
  expect(screen.queryByRole('button', { name: '复制请求体' })).toBeNull();
});

it.each([
  ['json', '{\n  "unfinished": "{{value}}",\n'],
  ['text', '  第一行 {{userId}}\nsecond line\n\n'],
] as const)('%s 正文直接复制原文，不要求 JSON 有效，也不展开变量', async (bodyType, body) => {
  loadBody(body, bodyType);
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: '复制请求体' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(body));
  expect(screen.getByLabelText('当前草稿').textContent).toBe(body);
  expect(screen.getByLabelText('未保存修改').textContent).toBe('false');
});

it('空正文禁用复制，保留已有剪贴板内容', async () => {
  loadBody('');
  await navigator.clipboard.writeText('previous clipboard');
  await openEditor();
  const copy = screen.getByRole('button', { name: '复制请求体' });
  expect((copy as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(copy);
  expect(await navigator.clipboard.readText()).toBe('previous clipboard');
});

it('剪贴板拒绝访问时提示手动复制，保留正文且不误报成功', async () => {
  const view = await openEditor();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  fireEvent.click(screen.getByRole('button', { name: '复制请求体' }));
  await waitFor(() => expect(screen.getByRole('status', { name: '操作提示' }).textContent).toContain('复制失败'));
  expect(screen.getByRole('status', { name: '操作提示' }).textContent).not.toContain('已复制');
  expect(view.state.doc.toString()).toBe('{"saved":true}');
  expect(screen.getByLabelText('未保存修改').textContent).toBe('false');
});

it('切换环境后复制该环境的正文，避免复制共享模板或其他环境内容', async () => {
  const workspace = loadBody('shared template');
  const request = workspace.requests[0];
  request.environmentConfigs = {
    'demo-dev': { ...request, body: '{"environment":"dev"}' },
    'demo-prod': { ...request, body: '{"environment":"prod"}' },
  };
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: '复制请求体' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('{"environment":"dev"}'));
  fireEvent.click(screen.getByRole('button', { name: '切换到生产环境' }));
  await waitFor(() => expect(screen.getByLabelText('当前草稿').textContent).toBe('{"environment":"prod"}'));
  fireEvent.click(screen.getByRole('button', { name: '复制请求体' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('{"environment":"prod"}'));
});

it.each(['none', 'form', 'multipart'] as const)('%s 类型不提供会误复制历史文本的正文按钮', async bodyType => {
  loadBody('stale text', bodyType);
  render(<Harness />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Body' }));
  expect(screen.queryByRole('button', { name: '复制请求体' })).toBeNull();
});
