import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { JsonArrayTable } from './JsonArrayTable';

afterEach(cleanup);
it('对象数组按数值排序、筛选、隐藏列，并可查看嵌套值', () => {
  render(<JsonArrayTable value={{ data: [{ id: 10, name: 'Beta', nested: { enabled: true } }, { id: 2, name: 'Alpha' }] }} />);
  fireEvent.click(screen.getByRole('button', { name: '按 id 排序' }));
  const table = screen.getByRole('table', { name: 'JSON 数组数据' });
  expect(within(table).getAllByRole('row')[1].textContent).toContain('2');
  fireEvent.change(screen.getByLabelText('筛选数组行'), { target: { value: 'Beta' } });
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /查看嵌套值/ }));
  expect(screen.getByLabelText('数组单元格详情').textContent).toContain('"enabled": true');
  fireEvent.click(screen.getByText('选择列'));
  fireEvent.click(screen.getByRole('checkbox', { name: '显示列 name' }));
  expect(within(table).queryByRole('columnheader', { name: /name/ })).toBeNull();
});
it('7525 行只渲染一页，切页保留原始下标，混合值与空数组可用', () => {
  const { rerender } = render(<JsonArrayTable value={Array.from({ length: 7525 }, (_, i) => i)} />);
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(51);
  expect(screen.getByText('7525 行 · 1 列')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一页数组' }));
  expect(within(screen.getByRole('table')).getAllByRole('row')[1].textContent).toBe('5050');
  rerender(<JsonArrayTable key="mixed" value={[null, { id: 1 }, 'x']} />);
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
  rerender(<JsonArrayTable key="empty" value={[]} />);
  expect(screen.getByText('数组为空')).toBeTruthy();
});
it('没有数组时提示，多个数组可切换且筛选隐藏列不丢失行', () => {
  const { rerender } = render(<JsonArrayTable value={{ id: 1 }} />);
  expect(screen.getByText('此响应没有可展示的数组')).toBeTruthy();
  rerender(<JsonArrayTable key="arrays" value={{ a: [1], b: [true, false] }} />);
  fireEvent.change(screen.getByLabelText('选择 JSON 数组'), { target: { value: '$.b' } });
  expect(screen.getByText('false')).toBeTruthy();
});
it('长字符串按完整内容排序，并可筛选预览范围之外的文字', () => {
  const prefix = 'a'.repeat(10_050);
  render(<JsonArrayTable value={[{ id: 1, text: prefix + 'Zulu' }, { id: 2, text: prefix + 'Alpha' }]} />);
  const table = screen.getByRole('table', { name: 'JSON 数组数据' });
  fireEvent.click(screen.getByRole('button', { name: '按 text 排序' }));
  expect(within(table).getAllByRole('row')[1].textContent).toMatch(/^12/);
  fireEvent.change(screen.getByLabelText('筛选数组行'), { target: { value: 'Zulu' } });
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  expect(within(table).getAllByRole('row')[1].textContent).toMatch(/^01/);
});
