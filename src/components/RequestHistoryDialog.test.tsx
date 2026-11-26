import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { RequestHistoryEntry } from '../types';
import { demoWorkspace } from '../lib/workspace';
import RequestHistoryDialog from './RequestHistoryDialog';

vi.mock('../lib/ipc', () => ({ desktop: true, api: { writeInvestigationReport: vi.fn().mockResolvedValue('report.html') } }));
import { api } from '../lib/ipc';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function entry(id: string, body = '{"value":1}', environmentId = 'demo-dev'): RequestHistoryEntry {
  return {
    id, projectId: 'demo-project', projectName: '项目', environmentId, environmentName: environmentId === 'demo-dev' ? '开发' : '生产',
    serviceName: '服务', startedAt: id === 'first' ? 100 : 200, finishedAt: 300,
    url: 'https://example.test/users', request: demoWorkspace().requests[0], temporaryVariables: [],
    response: { executionId: id, status: 200, statusText: 'OK', durationMs: 10, sizeBytes: 11,
      truncated: false, environmentName: '开发', url: 'https://example.test/users', body, headers: [] },
  };
}
const props = () => ({ entries: [entry('second', '{"value":2}', 'prod'), entry('first')], projectName: '项目',
  onClose: vi.fn(), onRestore: vi.fn().mockResolvedValue(true), onDelete: vi.fn(), onClear: vi.fn(), busy: false });

it('空窗口明确会话限额；筛选环境不会展示其他环境记录', () => {
  const value = props();
  const { rerender } = render(<RequestHistoryDialog {...value} entries={[]} />);
  expect(screen.getByText(/还没有执行记录/)).toBeTruthy();
  expect(screen.getByText(/50 条/)).toBeTruthy();
  rerender(<RequestHistoryDialog {...value} />);
  fireEvent.change(screen.getByLabelText('历史环境筛选'), { target: { value: 'prod' } });
  expect(screen.getAllByRole('button', { name: /查看记录/ })).toHaveLength(1);
  expect(screen.getByRole('button', { name: /查看记录 second/ })).toBeTruthy();
});

it('恢复只调用恢复草稿，成功后关闭；失败时保留窗口', async () => {
  const value = props();
  value.onRestore.mockResolvedValueOnce(false);
  render(<RequestHistoryDialog {...value} />);
  fireEvent.click(screen.getByRole('button', { name: '恢复为草稿' }));
  await waitFor(() => expect(value.onRestore).toHaveBeenCalledWith('second'));
  expect(value.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '恢复为草稿' }));
  await waitFor(() => expect(value.onClose).toHaveBeenCalledTimes(1));
});

it('选择两次记录后使用真实 JSON 对比，显示字段变更', async () => {
  render(<RequestHistoryDialog {...props()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '选择对比 first' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择对比 second' }));
  fireEvent.click(screen.getByRole('button', { name: /响应对比/ }));
  expect(await screen.findByText('$.value')).toBeTruthy();
});

it('排查包必须生成预览后才能保存；修改选项后旧预览失效', async () => {
  render(<RequestHistoryDialog {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: '问题排查包' }));
  expect((screen.getByRole('button', { name: '保存 HTML 排查包' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('问题现象'), { target: { value: '接口偶发慢' } });
  fireEvent.click(screen.getByRole('button', { name: '生成脱敏预览' }));
  expect((screen.getByLabelText('排查包内容预览') as HTMLTextAreaElement).value).toContain('接口偶发慢');
  fireEvent.click(screen.getByRole('button', { name: '保存 HTML 排查包' }));
  await waitFor(() => expect(api.writeInvestigationReport).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.writeInvestigationReport).mock.calls[0][0]).toContain('接口偶发慢');
  fireEvent.click(screen.getByRole('checkbox', { name: '包含响应正文' }));
  expect(screen.queryByLabelText('排查包内容预览')).toBeNull();
  expect((screen.getByRole('button', { name: '保存 HTML 排查包' }) as HTMLButtonElement).disabled).toBe(true);
});

it('新记录到达不改变默认选中记录，也不丢失现象、选项和预览', () => {
  const value = props();
  const { rerender } = render(<RequestHistoryDialog {...value} />);
  fireEvent.click(screen.getByRole('button', { name: '问题排查包' }));
  fireEvent.change(screen.getByLabelText('问题现象'), { target: { value: '不能丢失的排查草稿' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '包含响应正文' }));
  fireEvent.click(screen.getByRole('button', { name: '生成脱敏预览' }));
  rerender(<RequestHistoryDialog {...value} entries={[entry('late'), ...value.entries]} />);
  expect(screen.getByRole('button', { name: '查看记录 second' }).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByLabelText('问题现象') as HTMLTextAreaElement).value).toBe('不能丢失的排查草稿');
  expect((screen.getByLabelText('包含响应正文') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('排查包内容预览') as HTMLTextAreaElement).value).toContain('不能丢失的排查草稿');
});

it('所选记录被移除时明确提示，避免无说明地切换排查对象', () => {
  const value = props();
  const { rerender } = render(<RequestHistoryDialog {...value} />);
  rerender(<RequestHistoryDialog {...value} entries={[entry('replacement')]} />);
  expect(screen.getByText(/所选记录已移除或不符合筛选条件/)).toBeTruthy();
});

it('旧窗口发起的恢复完成后不能关闭重新打开的时间线', async () => {
  let resolve!: (value: boolean) => void;
  const pending = new Promise<boolean>(finish => { resolve = finish; });
  const value = props();
  function Harness() {
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>重新打开时间线</button>
      {open && <RequestHistoryDialog {...value} busy={busy} onClose={() => setOpen(false)} onRestore={async () => {
        setBusy(true);
        const result = await pending;
        setBusy(false);
        return result;
      }} />}
    </>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '恢复为草稿' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(screen.getByRole('button', { name: '重新打开时间线' }));
  fireEvent.click(screen.getByRole('button', { name: '问题排查包' }));
  fireEvent.change(screen.getByLabelText('问题现象'), { target: { value: '新窗口草稿' } });
  await act(async () => resolve(true));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByLabelText('问题现象') as HTMLTextAreaElement).value).toBe('新窗口草稿');
});
