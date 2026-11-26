import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Workbench } from '../hooks/useWorkbench';
import type { Workspace } from '../types';
import { demoWorkspace } from '../lib/workspace';
import { EntityManager } from './EntityManager';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

it.each(['项目', '环境'])('创建%s支持预设颜色和自定义 HEX；编辑保留颜色', kind => {
  let workspace = demoWorkspace();
  const model = {
    workspace, project: workspace.projects[0],
    mutate: (change: (w: Workspace) => Workspace) => { workspace = change(workspace); },
  } as Workbench;
  const { rerender } = render(<EntityManager model={model} />);
  fireEvent.click(screen.getByRole('button', { name: `新建${kind}` }));
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '颜色测试' } });
  fireEvent.click(screen.getByRole('button', { name: '预设颜色 #65D7C5' }));
  expect((screen.getByLabelText(`${kind}颜色 HEX`) as HTMLInputElement).value).toBe('#65D7C5');
  fireEvent.change(screen.getByLabelText(`${kind}颜色 HEX`), { target: { value: '#abcdef' } });
  fireEvent.click(screen.getByRole('button', { name: '应用到工作区' }));
  const rows = kind === '项目' ? workspace.projects : workspace.environments;
  expect(rows.at(-1)).toMatchObject({ name: '颜色测试', color: '#ABCDEF' });
  rerender(<EntityManager model={{ ...model, workspace }} />);
  fireEvent.click(screen.getByRole('button', { name: `编辑${kind} 颜色测试` }));
  expect((screen.getByLabelText(`${kind}颜色 HEX`) as HTMLInputElement).value).toBe('#ABCDEF');
});

it('非法 HEX 阻止提交，生产勾选与颜色独立', () => {
  const workspace = demoWorkspace();
  const mutate = vi.fn();
  render(<EntityManager model={{ workspace, project: workspace.projects[0], mutate } as unknown as Workbench} />);
  fireEvent.click(screen.getByRole('button', { name: '编辑环境 生产环境' }));
  const checkbox = screen.getByRole('checkbox', { name: /这是生产环境/ });
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('环境颜色 HEX'), { target: { value: 'red' } });
  fireEvent.click(screen.getByRole('button', { name: '应用到工作区' }));
  expect(mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('#RRGGBB');
  fireEvent.click(screen.getByRole('button', { name: '预设颜色 #65D7C5' }));
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '应用到工作区' }));
  expect(mutate).toHaveBeenCalledTimes(1);
});

it('默认颜色兼容缺少 color 的旧项目/环境', () => {
  const workspace = demoWorkspace();
  render(<EntityManager model={{ workspace, project: workspace.projects[0] } as Workbench} />);
  fireEvent.click(screen.getByRole('button', { name: '编辑项目 星河 · 开放平台' }));
  expect((screen.getByLabelText('项目颜色 HEX') as HTMLInputElement).value).toMatch(/^#[\dA-F]{6}$/);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑环境 开发环境' }));
  expect((screen.getByLabelText('环境颜色 HEX') as HTMLInputElement).value).toMatch(/^#[\dA-F]{6}$/);
});

it('管理页勾选正文表单清理后确认含基础模板，取消不执行', async () => {
  const workspace = demoWorkspace();
  const confirm = vi.fn().mockResolvedValue(false);
  const cleanData = vi.fn();
  render(<EntityManager model={{ workspace, project: workspace.projects[0], confirm, cleanData } as unknown as Workbench} />);
  const panel = within(screen.getByRole('region', { name: '数据清理' }));
  fireEvent.click(panel.getByRole('checkbox', { name: /请求正文和表单/ }));
  fireEvent.click(panel.getByRole('button', { name: '清理数据' }));
  await act(async () => {});
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/基础模板/) }));
  expect(cleanData).not.toHaveBeenCalled();
});
