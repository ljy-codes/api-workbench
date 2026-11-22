import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Workbench } from '../hooks/useWorkbench';
import type { RequestDefinition } from '../types';
import { demoWorkspace } from '../lib/workspace';
import { RequestEditor } from './RequestEditor';

vi.mock('../lib/ipc', () => ({ desktop: true }));
afterEach(cleanup);

function Harness({ bodyType = 'none' }: { bodyType?: RequestDefinition['bodyType'] }) {
  const workspace = demoWorkspace();
  const [request, setRequest] = useState({ ...workspace.requests[0], bodyType });
  const model = {
    workspace, request, project: workspace.projects[0], environment: workspace.environments[0],
    busy: false, dirty: false, preview: null,
    updateRequest: (patch: Partial<RequestDefinition>) => setRequest(r => ({ ...r, ...patch })),
    execute: vi.fn(), copyCurl: vi.fn(), setNotice: vi.fn(),
  } as unknown as Workbench;
  return <RequestEditor model={model} />;
}

it('常用区只保留 URL、正文类型与配置标签，低频操作放到更多菜单', () => {
  render(<Harness />);
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.queryByRole('button', { name: '保存工作区' })).toBeNull();
  const more = screen.getByLabelText('更多请求操作');
  const menu = more.closest('details');
  expect(menu?.open).toBe(false);
  expect(screen.getByRole('button', { name: '发送请求' })).toBeTruthy();
  fireEvent.click(more);
  expect(menu?.open).toBe(true);
  expect(screen.getByRole('button', { name: '脱敏预览' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '复制脱敏 cURL' })).toBeTruthy();
  expect(screen.getByLabelText('超时时间（毫秒）')).toBeTruthy();
});

it('从同一行切换到表单类型会直接打开正文，保留全部正文类型', () => {
  render(<Harness />);
  const select = screen.getByLabelText('正文类型');
  expect(select.closest('.editor-tabs')).toBeTruthy();
  expect(select.querySelectorAll('option')).toHaveLength(5);
  fireEvent.change(select, { target: { value: 'form' } });
  expect(screen.getByRole('tab', { name: 'Body' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: '添加表单项' })).toBeTruthy();
});
