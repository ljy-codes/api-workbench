import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { JsonInspector } from './JsonInspector';

afterEach(cleanup);
it('通过路径定位特殊字段并分别复制路径、值、所在对象', async () => {
  userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const value = { data: [{ 'a.b': 'hello', id: 1 }] };
  const text = JSON.stringify(value, null, 2);
  const locate = vi.fn();
  render(<JsonInspector value={value} text={text} onLocate={locate} />);
  fireEvent.change(screen.getByLabelText('JSON 字段路径'), { target: { value: '$.data[0]["a.b"]' } });
  fireEvent.click(screen.getByRole('button', { name: '定位字段' }));
  expect(locate).toHaveBeenCalledWith(expect.objectContaining({ from: text.indexOf('"hello"'), to: text.indexOf('"hello"') + 7 }));
  fireEvent.click(screen.getByRole('button', { name: '复制字段路径' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('$.data[0]["a.b"]'));
  fireEvent.click(screen.getByRole('button', { name: '复制字段值' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('"hello"'));
  fireEvent.click(screen.getByRole('button', { name: '复制所在对象' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(JSON.stringify(value.data[0], null, 2)));
  copy.mockRestore();
});
it('未知路径和非法路径明确提示，点击正文同步路径', () => {
  const props = { value: { data: null }, text: '{\n  "data": null\n}', onLocate: vi.fn() };
  const { rerender } = render(<JsonInspector {...props} />);
  fireEvent.change(screen.getByLabelText('JSON 字段路径'), { target: { value: '$.missing' } });
  fireEvent.click(screen.getByRole('button', { name: '定位字段' }));
  expect(screen.getByRole('alert').textContent).toContain('不存在');
  expect(props.onLocate).not.toHaveBeenCalled();
  rerender(<JsonInspector {...props} selectedPath={['data']} />);
  expect((screen.getByLabelText('JSON 字段路径') as HTMLInputElement).value).toBe('$.data');
  expect(screen.queryByRole('alert')).toBeNull();
});
