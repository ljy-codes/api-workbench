import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ColorSelect } from './ColorSelect';

afterEach(cleanup);
const options = [
  { value: 'dev', label: '开发', color: '#000000' },
  { value: 'prod', label: '生产环境', color: '#65D7C5', isProduction: true },
  { value: 'test', label: 'Test' },
];
it('方向键/Home/End/Enter 选择，Escape 取消并保持触发器焦点', async () => {
  const onChange = vi.fn();
  render(<ColorSelect label="当前环境" options={options} value="dev" onChange={onChange} />);
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole('combobox', { name: '当前环境' });
  await user.keyboard('{ArrowDown}{End}{Home}{ArrowDown}{Enter}');
  expect(onChange).toHaveBeenCalledWith('prod');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard(' {ArrowDown}{Escape}');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('Tab 关闭并移至下一个控件，不锁住焦点；点击外部也关闭', async () => {
  render(<><ColorSelect label="当前环境" options={options} value="dev" onChange={vi.fn()} /><button>下一项</button></>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '下一项' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.click(screen.getByRole('combobox'));
  await user.click(screen.getByRole('button', { name: '下一项' }));
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('字符定位选项，颜色仅作用于色点，生产文字独立存在', () => {
  const onChange = vi.fn();
  render(<ColorSelect label="当前环境" options={options} value="dev" onChange={onChange} />);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  const production = screen.getByRole('option', { name: '生产环境 生产' });
  expect(production.style.color).toBe('');
  expect(production.querySelector<HTMLElement>('.color-dot')?.style.backgroundColor).toBe('rgb(101, 215, 197)');
  fireEvent.keyDown(trigger, { key: 't' });
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.textContent).toBe('Test');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('test');
});
it('禁用状态不能打开；异步变忙关闭已打开的列表；旧值/非法颜色使用默认色', () => {
  const props = { label: '项目', options: [{ value: 'p', label: '旧项目', color: 'invalid' }], value: 'p', onChange: vi.fn() };
  const { rerender } = render(<ColorSelect {...props} />);
  const trigger = screen.getByRole('combobox');
  expect(trigger.querySelector<HTMLElement>('.color-dot')?.style.backgroundColor).not.toBe('');
  fireEvent.click(trigger);
  rerender(<ColorSelect {...props} disabled />);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.queryByRole('listbox')).toBeNull();
});
