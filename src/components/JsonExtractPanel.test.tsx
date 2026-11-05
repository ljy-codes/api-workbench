import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JsonExtractPanel } from './JsonExtractPanel';

beforeEach(() => { userEvent.setup(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function resultText() {
  return EditorView.findFromDOM(screen.getByLabelText('提取结果'))!.state.doc.toString();
}

it('按路径批量提取并复制精确长整数，支持输出格式与去重', async () => {
  render(<JsonExtractPanel source='{"data":[{"id":9223372036854775807},{"id":9223372036854775807},{"id":9223372036854775808}]}' onUseResult={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$.data[*].id' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '结果去重' }));
  fireEvent.change(screen.getByRole('combobox', { name: '输出格式' }), { target: { value: 'sql' } });
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  await waitFor(() => expect(resultText()).toBe('IN (9223372036854775807, 9223372036854775808)'));
  expect(screen.getByRole('status').textContent).toContain('2');
  fireEvent.click(screen.getByRole('button', { name: '复制提取结果' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('IN (9223372036854775807, 9223372036854775808)'));
});

it('源文或规则改变立即丢弃旧结果，不能继续复制或回填旧数据', async () => {
  const onUseResult = vi.fn();
  const { rerender } = render(<JsonExtractPanel source='{"data":[1,2]}' onUseResult={onUseResult} />);
  fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$.data[*]' } });
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  await waitFor(() => expect(resultText()).toContain('1'));
  fireEvent.click(screen.getByRole('button', { name: '用结果替换原文' }));
  expect(onUseResult).toHaveBeenCalledWith('[\n  1,\n  2\n]');
  rerender(<JsonExtractPanel source='{"data":[3]}' onUseResult={onUseResult} />);
  expect(screen.getByRole('button', { name: '复制提取结果' })).toBeDisabled();
  expect(resultText()).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  await waitFor(() => expect(resultText()).toContain('3'));
  fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$.missing' } });
  expect(screen.getByRole('button', { name: '复制提取结果' })).toBeDisabled();
  expect(resultText()).toBe('');
});

it('错误保留输入并提示，无匹配可明确识别，复制失败可以重试', async () => {
  render(<JsonExtractPanel source='{"data":[1]}' onUseResult={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$..id' } });
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '提取路径' }) as HTMLInputElement).value).toBe('$..id');
  fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$.missing' } });
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  await waitFor(() => expect(resultText()).toBe('[]'));
  expect(screen.getByRole('status').textContent).toContain('0');
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: '复制提取结果' }));
  expect((await screen.findByRole('alert')).textContent).toContain('复制失败');
});

it.each([
  ['source', true], ['source', false],
  ['rule', true], ['rule', false],
  ['clear', true], ['clear', false],
] as const)('复制未完成时 %s（成功=%s），不显示过期反馈', async (action, succeeds) => {
  const onUseResult = vi.fn();
  const { rerender } = render(<JsonExtractPanel source='{"id":1}' onUseResult={onUseResult} />);
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  let finish!: () => void;
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve, reject) => {
    finish = () => succeeds ? resolve() : reject(new Error('denied'));
  }));
  fireEvent.click(screen.getByRole('button', { name: '复制提取结果' }));
  if (action === 'source') rerender(<JsonExtractPanel source='{"id":2}' onUseResult={onUseResult} />);
  else if (action === 'rule') fireEvent.change(screen.getByRole('textbox', { name: '提取路径' }), { target: { value: '$.id' } });
  else fireEvent.click(screen.getByRole('button', { name: '清空提取' }));
  await act(async () => { finish(); });
  expect(screen.getByRole('status')).not.toHaveTextContent('已复制');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '复制提取结果' })).toBeDisabled();
  expect(resultText()).toBe('');
});

it('原文修改后清除旧反馈，恢复原文也必须重新提取', async () => {
  const onUseResult = vi.fn();
  const { rerender } = render(<JsonExtractPanel source='{"id":1}' onUseResult={onUseResult} />);
  fireEvent.click(screen.getByRole('button', { name: '提取字段' }));
  fireEvent.click(screen.getByRole('button', { name: '复制提取结果' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'));
  rerender(<JsonExtractPanel source='{"id":2}' onUseResult={onUseResult} />);
  expect(screen.getByRole('status')).not.toHaveTextContent('已复制');
  rerender(<JsonExtractPanel source='{"id":1}' onUseResult={onUseResult} />);
  expect(screen.getByRole('button', { name: '复制提取结果' })).toBeDisabled();
  expect(resultText()).toBe('');
});
