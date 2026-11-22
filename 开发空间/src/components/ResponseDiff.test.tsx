import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { ResponseDiff } from './ResponseDiff';
import { parseExactJson } from '../lib/json-exact';

afterEach(cleanup);

it('labels additions, removals and changes and shows both values', () => {
  render(<ResponseDiff baseline={{ gone: 1, value: 'before' }} current={{ fresh: 2, value: 'after' }} />);
  const list = screen.getByRole('list', { name: 'JSON 差异' });
  expect(within(list).getByText('新增')).toBeTruthy();
  expect(within(list).getByText('删除')).toBeTruthy();
  expect(within(list).getByText('修改')).toBeTruthy();
  expect(within(list).getByText('$.gone')).toBeTruthy();
  expect(within(list).getByText('"before"')).toBeTruthy();
  expect(within(list).getByText('"after"')).toBeTruthy();
});

it('applies field names and exact paths and can clear ignore rules', async () => {
  const user = userEvent.setup();
  render(<ResponseDiff
    baseline={{ timestamp: 1, data: [{ timestamp: 1, count: 1 }], other: 1 }}
    current={{ timestamp: 2, data: [{ timestamp: 2, count: 2 }], other: 2 }}
  />);
  await user.type(screen.getByRole('textbox', { name: '忽略字段或路径' }), 'timestamp, $.data[[0].count');
  expect(screen.getByRole('textbox', { name: '忽略字段或路径' })).toHaveValue('timestamp, $.data[0].count');
  await user.click(screen.getByRole('button', { name: '应用忽略规则' }));
  const list = screen.getByRole('list', { name: 'JSON 差异' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(within(list).getByText('$.other')).toBeTruthy();
  await user.clear(screen.getByRole('textbox', { name: '忽略字段或路径' }));
  await user.click(screen.getByRole('button', { name: '应用忽略规则' }));
  expect(within(screen.getByRole('list', { name: 'JSON 差异' })).getAllByRole('listitem')).toHaveLength(4);
});

it('preserves commas inside quoted exact paths in the ignore input', () => {
  render(<ResponseDiff baseline={{ 'a,b': 1, keep: 1 }} current={{ 'a,b': 2, keep: 2 }} />);
  fireEvent.change(screen.getByRole('textbox', { name: '忽略字段或路径' }), { target: { value: '$["a,b"]' } });
  fireEvent.click(screen.getByRole('button', { name: '应用忽略规则' }));
  expect(screen.queryByText('$["a,b"]')).toBeNull();
  expect(screen.getByText('$.keep')).toBeTruthy();
});

it('lets users enable id matching and explains the fallback and displayed indexes', () => {
  render(<ResponseDiff
    baseline={[{ id: 1, name: 'one' }, { id: 2, name: 'two' }]}
    current={[{ id: 2, name: 'two' }, { id: 1, name: 'one' }]}
  />);
  expect(screen.getByRole('list', { name: 'JSON 差异' })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: '数组按 id 匹配' }));
  expect(screen.getByText(/未发现差异/)).toBeTruthy();
  expect(screen.getByText(/两侧.*唯一.*string.*number.*否则按下标/)).toBeTruthy();
  expect(screen.getByText(/当前响应下标.*删除.*基准下标/)).toBeTruthy();
});

it('still shows differences for mixed arrays with id matching enabled', () => {
  render(<ResponseDiff baseline={[{ id: 1 }, null]} current={[null, { id: 1 }]} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '数组按 id 匹配' }));
  expect(within(screen.getByRole('list', { name: 'JSON 差异' })).getAllByRole('listitem')).toHaveLength(2);
});

it('renders only 50 changes per page and resets the page after ignore rules are applied', () => {
  render(<ResponseDiff baseline={Array(121).fill(0)} current={Array(121).fill(1)} />);
  const previous = screen.getByRole('button', { name: '上一页差异' });
  const next = screen.getByRole('button', { name: '下一页差异' });
  expect(previous).toBeDisabled();
  expect(screen.getByText('第 1 / 3 页')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'JSON 差异' })).getAllByRole('listitem')).toHaveLength(50);
  expect(screen.queryByText('$[50]')).toBeNull();
  fireEvent.click(next);
  expect(screen.getByText('$[50]')).toBeTruthy();
  expect(screen.queryByText('$[0]')).toBeNull();
  fireEvent.click(next);
  expect(within(screen.getByRole('list', { name: 'JSON 差异' })).getAllByRole('listitem')).toHaveLength(21);
  expect(next).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: '忽略字段或路径' }), { target: { value: '$[0]' } });
  fireEvent.click(screen.getByRole('button', { name: '应用忽略规则' }));
  expect(screen.getByText('第 1 / 3 页')).toBeTruthy();
  expect(screen.getByText('$[1]')).toBeTruthy();
});

it('resets pagination when parent responses change while retaining local ignore settings', () => {
  const baseline = Array(101).fill(0);
  const current = Array(101).fill(1);
  const { rerender } = render(<ResponseDiff baseline={baseline} current={current} />);
  fireEvent.click(screen.getByRole('button', { name: '下一页差异' }));
  fireEvent.change(screen.getByRole('textbox', { name: '忽略字段或路径' }), { target: { value: 'timestamp' } });
  fireEvent.click(screen.getByRole('button', { name: '应用忽略规则' }));
  fireEvent.click(screen.getByRole('button', { name: '下一页差异' }));
  rerender(<ResponseDiff baseline={{ timestamp: 1, a: 1 }} current={{ timestamp: 2, a: 2 }} />);
  expect(screen.getByRole('textbox', { name: '忽略字段或路径' })).toHaveValue('timestamp');
  expect(screen.getByText('$.a')).toBeTruthy();
  expect(screen.queryByText('$.timestamp')).toBeNull();
  expect(screen.queryByText(/第 2/)).toBeNull();
});

it('warns when the change limit is exceeded and keeps the DOM paginated', () => {
  render(<ResponseDiff baseline={Array(1500).fill(0)} current={Array(1500).fill(1)} />);
  expect(screen.getByRole('alert').textContent).toMatch(/达到.*上限.*未完成.*不能判定/);
  expect(screen.queryByText(/未发现差异/)).toBeNull();
  expect(within(screen.getByRole('list', { name: 'JSON 差异' })).getAllByRole('listitem')).toHaveLength(50);
});

it('does not claim equality when a node budget expires before the first difference', () => {
  const baseline = Array(30_000).fill(0);
  const current = [...baseline];
  current[29_999] = 1;
  render(<ResponseDiff baseline={baseline} current={current} />);
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText(/未发现差异/)).toBeNull();
});

it('limits long value previews and expands only the value requested by the user', () => {
  const value = `${'x'.repeat(1000)}END_OF_VALUE`;
  render(<ResponseDiff baseline={{ text: 'old' }} current={{ text: value }} />);
  expect(screen.queryByText(`"${value}"`)).toBeNull();
  expect(screen.getByRole('list', { name: 'JSON 差异' }).textContent!.length).toBeLessThan(800);
  const expand = screen.getByRole('button', { name: '展开当前值 $.text' });
  fireEvent.click(expand);
  expect(screen.getByText(`"${value}"`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '收起当前值 $.text' }));
  expect(screen.queryByText(`"${value}"`)).toBeNull();
});

it('bounds serialization of deep object values and reports a still-incomplete expansion', () => {
  let deep: unknown = { end: true };
  for (let depth = 0; depth < 12_000; depth++) deep = { next: deep };
  render(<ResponseDiff baseline={null} current={deep} />);
  fireEvent.click(screen.getByRole('button', { name: '展开当前值 $' }));
  expect(screen.getByText(/值过长或过深.*仍为部分内容/)).toBeTruthy();
  expect(screen.getByRole('list', { name: 'JSON 差异' }).textContent!.length).toBeLessThan(22_000);
});

it('shows equality only after a complete comparison and treats null as valid JSON', () => {
  render(<ResponseDiff baseline={null} current={null} />);
  expect(screen.getByText(/未发现差异/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('displays exact numeric tokens rather than their internal representation, including added subtrees', () => {
  render(<ResponseDiff
    baseline={parseExactJson('{"id":9223372036854775807,"amount":0.12345678901234567890}')}
    current={parseExactJson('{"id":9223372036854775808,"amount":0.12345678901234567891,"added":{"n":9007199254740993}}')}
  />);
  const list = screen.getByRole('list', { name: 'JSON 差异' });
  expect(within(list).getByText('9223372036854775807')).toBeTruthy();
  expect(within(list).getByText('9223372036854775808')).toBeTruthy();
  expect(within(list).getByText('0.12345678901234567891')).toBeTruthy();
  expect(within(list).getByText('{"n":9007199254740993}')).toBeTruthy();
  expect(list.textContent).not.toContain('canonical');
});
