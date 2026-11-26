import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { demoWorkspace } from '../lib/workspace';
import type { Preview } from '../types';
import type { Workbench } from '../hooks/useWorkbench';
import { RequestEditor } from './RequestEditor';

vi.mock('../lib/ipc', () => ({ desktop: true }));

afterEach(cleanup);

function createModel(overrides: Partial<Workbench> = {}) {
  const workspace = demoWorkspace();
  const request = workspace.requests[0];
  return {
    workspace,
    project: workspace.projects[0],
    environment: workspace.environments[0],
    request,
    selectedId: request.id,
    execution: undefined,
    preview: { url: 'https://api.example.test/users', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [] } satisfies Preview,
    busy: false,
    loading: false,
    updateRequest: vi.fn(),
    execute: vi.fn(),
    cancel: vi.fn(),
    setNotice: vi.fn(),
    pickFile: vi.fn().mockResolvedValue(null),
    copyCurl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Workbench;
}

it('常驻显示脱敏 URL 预览', () => {
  render(<RequestEditor model={createModel()} />);
  expect(screen.getByText('https://api.example.test/users')).toBeVisible();
  expect(screen.queryByRole('button', { name: '关闭地址预览' })).toBeNull();
});

it('复制脱敏 cURL 作为请求工具按钮显示', () => {
  const copyCurl = vi.fn().mockResolvedValue(undefined);
  render(<RequestEditor model={createModel({ copyCurl })} />);
  fireEvent.click(screen.getByRole('button', { name: '复制脱敏 cURL' }));
  expect(copyCurl).toHaveBeenCalledTimes(1);
});

it('超时工具按钮显示当前秒数，菜单仍提供毫秒输入', () => {
  const workspace = demoWorkspace();
  const request = { ...workspace.requests[0], timeoutMs: 45000 };
  render(<RequestEditor model={createModel({ workspace, request })} />);
  expect(screen.getByRole('button', { name: '超时 45s' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '超时 45s' }));
  expect(screen.getByLabelText('超时时间（毫秒）')).toHaveValue(45000);
});
