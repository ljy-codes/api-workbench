import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataCleanup } from './DataCleanup';

afterEach(cleanup);
const createModel = () => ({
  busy: false, loading: false, hasRunning: false, confirmation: null,
  confirm: vi.fn().mockResolvedValue(true), cleanData: vi.fn().mockResolvedValue(true),
});
it('默认仅清全部响应，明确最新缓存、自动淘汰与正文保护策略', async () => {
  const model = createModel();
  render(<DataCleanup model={model} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/不保存响应历史/)).toBeTruthy();
  expect(screen.getByText(/64 MiB/)).toBeTruthy();
  expect(screen.getByText(/请求正文和表单不会自动清除/)).toBeTruthy();
  expect(screen.getByText(/已有手动备份会保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  await act(async () => {});
  expect(model.cleanData).toHaveBeenCalledWith(false);
  expect(model.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/所有项目.*所有环境/), danger: true }));
});
it('显式勾选才清请求正文表单，包括基础模板且保留路径参数鉴权域名', async () => {
  const model = createModel();
  render(<DataCleanup model={model} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  await act(async () => {});
  expect(model.cleanData).toHaveBeenCalledWith(true);
  expect(model.confirm.mock.calls[0][0].message).toMatch(/基础模板/);
  expect(model.confirm.mock.calls[0][0].message).toMatch(/路径.*参数.*鉴权.*域名/);
});
it.each(['busy', 'loading', 'hasRunning'] as const)('%s 阻止清理与确认', flag => {
  const model = { ...createModel(), [flag]: true };
  render(<DataCleanup model={model} />);
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  expect(model.confirm).not.toHaveBeenCalled();
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
});
it('确认后重新检查运行状态，防止等待确认时开始的请求被清除', async () => {
  let finish!: (yes: boolean) => void;
  const model = createModel();
  model.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(<DataCleanup model={model} />);
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  rerender(<DataCleanup model={{ ...model, hasRunning: true }} />);
  await act(async () => finish(true));
  expect(model.cleanData).not.toHaveBeenCalled();
});
it('重复点击不重复确认；取消不清理，失败不声称完成', async () => {
  let finish!: (yes: boolean) => void;
  const model = createModel();
  model.confirm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<DataCleanup model={model} />);
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  expect(model.confirm).toHaveBeenCalledTimes(1);
  await act(async () => finish(false));
  expect(model.cleanData).not.toHaveBeenCalled();
  model.cleanData.mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: '清理数据' }));
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('未完成');
  expect(screen.queryByText('数据清理完成')).toBeNull();
});
