import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponsePanel } from './ResponsePanel';
import { EditorView } from '@uiw/react-codemirror';
import { foldedRanges } from '@codemirror/language';
import userEvent from '@testing-library/user-event';

afterEach(cleanup);
it('清除按钮仅在有执行且未运行时可用，回调可选', () => {
  const execution = { id: 'e', requestId: 'r', requestName: '接口', environment: '开发', running: false, error: 'failed' };
  const onClear = vi.fn();
  const { rerender } = render(<ResponsePanel execution={execution} onClear={onClear} />);
  fireEvent.click(screen.getByRole('button', { name: '清除当前响应' }));
  expect(onClear).toHaveBeenCalledTimes(1);
  rerender(<ResponsePanel execution={{ ...execution, running: true }} onClear={onClear} />);
  expect((screen.getByRole('button', { name: '清除当前响应' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '清除当前响应' }));
  expect(onClear).toHaveBeenCalledTimes(1);
  rerender(<ResponsePanel onClear={onClear} />);
  expect((screen.getByRole('button', { name: '清除当前响应' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ResponsePanel execution={execution} />);
  expect(screen.queryByRole('button', { name: '清除当前响应' })).toBeNull();
});
it('正文搜索对 JSON 与原始文本高亮匹配，并显示未匹配结果', async () => {
  render(<ResponsePanel execution={{ id: 'e', requestId: 'r', requestName: '搜索', environment: '开发', running: false, response: { executionId: 'e', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 30, body: '{"name":"Alice","other":"alice"}', headers: [], truncated: false, environmentName: '开发', url: 'https://example.com' } }} />);
  expect(screen.queryByLabelText('搜索响应正文')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查找响应正文' }));
  fireEvent.change(screen.getByLabelText('搜索响应正文'), { target: { value: 'alice' } });
  expect(screen.getByText('2 处匹配')).toBeTruthy();
  await waitFor(() => expect(document.querySelectorAll('mark')).toHaveLength(2));
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'text' } });
  await waitFor(() => expect(document.querySelectorAll('mark')).toHaveLength(2));
  fireEvent.change(screen.getByLabelText('搜索响应正文'), { target: { value: 'absent' } });
  expect(screen.getByText('0 处匹配')).toBeTruthy();
});
it('默认保留响应环境，执行 ID 与地址在详情中按需显示', () => {
  render(<ResponsePanel execution={{ id: 'execution-detail', requestId: 'r', requestName: '查询', environment: '开发', running: false, response: { executionId: 'execution-detail', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 2, body: '{}', headers: [], truncated: false, environmentName: '开发', url: 'https://example.test/path' } }} />);
  expect(screen.getByText('开发')).toBeTruthy();
  expect(screen.queryByText('https://example.test/path')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '执行详情' }));
  expect(screen.getByText('execution-detail')).toBeTruthy();
  expect(screen.getByText('https://example.test/path')).toBeTruthy();
});
it('超限响应展示已接收大小并说明停止接收，不声称完整响应', () => {
  render(<ResponsePanel execution={{ id: 'e', requestId: 'r', requestName: '大响应', environment: '开发', running: false, response: { executionId: 'e', status: 200, statusText: 'OK', durationMs: 20, sizeBytes: 2048, body: 'partial', headers: [], truncated: true, environmentName: '开发', url: 'https://example.com' } }} />);
  expect(screen.getByText('已接收 2.0 KB')).toBeTruthy();
  expect(screen.getByText(/响应不完整.*已停止接收/)).toBeTruthy();
});

it('响应可一键收起内部容器查看根字段，再全部展开且正文不变', async () => {
  const raw = JSON.stringify({ code: 200, message: 'success', data: { instanceIds: Array.from({ length: 128 }, (_, i) => String(i)) }, extra: [true, false] });
  render(<ResponsePanel execution={{ id: 'fold', requestId: 'r', requestName: '大响应', environment: '开发', running: false, response: { executionId: 'fold', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated: false, environmentName: '开发', url: 'https://example.test' } }} />);
  const content = await screen.findByLabelText('响应正文');
  const view = EditorView.findFromDOM(content)!;
  const full = JSON.stringify(JSON.parse(raw), null, 2);
  fireEvent.click(screen.getByRole('button', { name: '全部收起响应 JSON' }));
  await waitFor(() => expect(foldedRanges(view.state).size).toBeGreaterThan(0));
  expect(content.textContent).toContain('"code": 200');
  expect(content.textContent).toContain('"message": "success"');
  expect(content.textContent).toContain('1 个字段');
  expect(view.state.doc.toString()).toBe(full);
  fireEvent.click(screen.getByRole('button', { name: '全部展开响应 JSON' }));
  await waitFor(() => expect(foldedRanges(view.state).size).toBe(0));
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'text' } });
  expect(screen.queryByRole('button', { name: '全部收起响应 JSON' })).toBeNull();
  expect(view.state.doc.toString()).toBe(raw);
});

it('根数组可整体收起，展开根数组后仍能逐项检查内部对象', async () => {
  const raw = JSON.stringify([{ id: 1 }, { id: 2 }]);
  render(<ResponsePanel execution={{ id: 'array', requestId: 'r', requestName: '数组', environment: '开发', running: false, response: { executionId: 'array', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated: false, environmentName: '开发', url: 'https://example.test' } }} />);
  const content = await screen.findByLabelText('响应正文');
  fireEvent.click(screen.getByRole('button', { name: '全部收起响应 JSON' }));
  expect(screen.getByRole('button', { name: '展开 2 项' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '展开 2 项' }));
  expect(screen.getAllByRole('button', { name: '展开 1 个字段' })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '全部展开响应 JSON' }));
  expect(foldedRanges(EditorView.findFromDOM(content)!.state).size).toBe(0);
});

it('收起后复制仍取原始响应，查找统计包含折叠内容且不改动折叠状态', async () => {
  userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const raw = '{"data":{"name":"Alice","other":"alice"}}';
  render(<ResponsePanel execution={{ id: 'copy', requestId: 'r', requestName: '复制', environment: '开发', running: false, response: { executionId: 'copy', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated: false, environmentName: '开发', url: 'https://example.test' } }} />);
  const content = await screen.findByLabelText('响应正文');
  const view = EditorView.findFromDOM(content)!;
  fireEvent.click(screen.getByRole('button', { name: '全部收起响应 JSON' }));
  const folded = foldedRanges(view.state).size;
  fireEvent.click(screen.getByRole('button', { name: '复制响应正文' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
  fireEvent.click(screen.getByRole('button', { name: '查找响应正文' }));
  fireEvent.change(screen.getByLabelText('搜索响应正文'), { target: { value: 'alice' } });
  expect(screen.getByText('2 处匹配')).toBeTruthy();
  expect(foldedRanges(view.state).size).toBe(folded);
  copy.mockRestore();
});

it.each(['plain text', '{"data": [1,', ''])('非 JSON 或空响应不提供 JSON 折叠操作：%s', async raw => {
  render(<ResponsePanel execution={{ id: 'text', requestId: 'r', requestName: '文本', environment: '开发', running: false, response: { executionId: 'text', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated: false, environmentName: '开发', url: 'https://example.test' } }} />);
  expect(screen.queryByRole('button', { name: '全部收起响应 JSON' })).toBeNull();
  expect(screen.queryByRole('button', { name: '全部展开响应 JSON' })).toBeNull();
});

it.each([
  { raw: '{"data":[1,2]}', truncated: true },
  { raw: 'plain text', truncated: false },
  { raw: '{"data":[1,', truncated: false },
])('不完整或非 JSON 响应禁用结构化检查且仍可复制原文：%j', async ({ raw, truncated }) => {
  userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  render(<ResponsePanel execution={{ id: 'limited', requestId: 'r', requestName: '降级', environment: '开发', running: false, response: { executionId: 'limited', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated, environmentName: '开发', url: 'https://example.test' } }} />);
  expect(screen.queryByRole('option', { name: '数组表格' })).toBeNull();
  expect(screen.queryByRole('option', { name: '响应对比' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'JSON 字段定位' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '复制响应正文' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
  copy.mockRestore();
});

it('数组嵌套值可跳回 JSON 并选中对应字段，表格模式复制仍是原文', async () => {
  userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const raw = '{"data":[{"id":1,"meta":{"enabled":true}}]}';
  render(<ResponsePanel execution={{ id: 'inspect', requestId: 'r', requestName: '定位', environment: '开发', running: false, response: { executionId: 'inspect', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: raw.length, body: raw, headers: [], truncated: false, environmentName: '开发', url: 'https://example.test' } }} />);
  fireEvent.change(screen.getByLabelText('响应显示格式'), { target: { value: 'table' } });
  fireEvent.click(await screen.findByRole('button', { name: '查看嵌套值 $.data[0].meta' }));
  expect(screen.getByLabelText('数组单元格详情').textContent).toContain('"enabled": true');
  fireEvent.click(screen.getByRole('button', { name: '复制响应正文' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
  fireEvent.click(screen.getByRole('button', { name: '在 JSON 中定位' }));
  const content = await screen.findByLabelText('响应正文');
  expect((screen.getByLabelText('响应显示格式') as HTMLSelectElement).value).toBe('json');
  expect((screen.getByLabelText('JSON 字段路径') as HTMLInputElement).value).toBe('$.data[0].meta');
  const view = EditorView.findFromDOM(content)!;
  await waitFor(() => expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toContain('"enabled": true'));
  copy.mockRestore();
});
