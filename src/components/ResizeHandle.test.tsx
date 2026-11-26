import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ResizeHandle';

afterEach(cleanup);

it('双击分隔条恢复当前布局默认值', () => {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(<ResizeHandle label="请求面板高度" orientation="horizontal" value={420} min={160} max={720} onChange={onChange} onReset={onReset} />);

  fireEvent.doubleClick(screen.getByRole('separator', { name: '请求面板高度' }));

  expect(onReset).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});
