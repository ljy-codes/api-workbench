import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponsePanel } from './ResponsePanel';

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
