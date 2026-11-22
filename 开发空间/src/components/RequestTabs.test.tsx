import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { demoWorkspace } from '../lib/workspace';
import type { Workbench } from '../hooks/useWorkbench';
import { RequestTabs } from './RequestTabs';

afterEach(cleanup);

function createModel(ids: string[]) {
  const workspace = demoWorkspace();
  workspace.requests = ids.map((id, index) => ({
    ...workspace.requests[index % workspace.requests.length],
    id,
    name: id,
  }));
  workspace.services = workspace.services.slice(0, 1);
  workspace.requests = workspace.requests.map(request => ({ ...request, serviceId: 'demo-users' }));
  const model = {
    workspace,
    project: workspace.projects[0],
    openTabs: ids,
    selectedId: ids[1] ?? ids[0] ?? null,
    busy: false,
    loading: false,
    selectRequest: vi.fn(),
    closeTab: vi.fn(),
    closeTabs: vi.fn(),
    closeAllTabs: vi.fn(),
  };
  return model as unknown as Workbench & { closeTabs: ReturnType<typeof vi.fn> };
}

it('标签右键菜单支持关闭当前、关闭其他和关闭右侧', () => {
  const model = createModel(['one', 'two', 'three']);
  render(<RequestTabs model={model} />);
  fireEvent.contextMenu(screen.getByRole('tab', { name: '切换到 two' }));
  expect(screen.getByRole('menu', { name: '标签管理' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '关闭其他标签' }));
  expect(model.closeTabs).toHaveBeenCalledWith(['one', 'three']);
});

it('全部标签入口列出当前项目已打开接口并能切换', () => {
  const model = createModel(['one', 'two']);
  render(<RequestTabs model={model} />);
  fireEvent.click(screen.getByRole('button', { name: '全部标签' }));
  expect(screen.getByRole('menuitem', { name: '切换到 one' })).toBeTruthy();
});
