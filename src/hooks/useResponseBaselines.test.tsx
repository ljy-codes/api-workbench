import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useResponseBaselines } from './useResponseBaselines';

it('基准跨执行变化保留，接口环境隔离且只存在当前应用会话', () => {
  const { result, rerender, unmount } = renderHook(({ context }) => useResponseBaselines(context), { initialProps: { context: 'request-a/dev' } });
  act(() => { expect(result.current.saveBaseline('{"id":1}')).toBe(true); });
  const baseline = result.current.baseline;
  rerender({ context: 'request-a/prod' });
  expect(result.current.baseline).toBeUndefined();
  rerender({ context: 'request-a/dev' });
  expect(result.current.baseline).toBe(baseline);
  act(() => result.current.clearBaseline());
  expect(result.current.baseline).toBeUndefined();
  unmount();
  const next = renderHook(() => useResponseBaselines('request-a/dev'));
  expect(next.result.current.baseline).toBeUndefined();
});
it('限制基准数目及正文内存，拒绝过大基准并保留现有内容', () => {
  const { result, rerender } = renderHook(({ context }) => useResponseBaselines(context), { initialProps: { context: 'r0' } });
  for (let i = 0; i < 9; i++) {
    rerender({ context: `r${i}` });
    act(() => { result.current.saveBaseline('{}'); });
  }
  rerender({ context: 'r0' });
  expect(result.current.baseline).toBeUndefined();
  rerender({ context: 'r8' });
  act(() => { expect(result.current.saveBaseline('x'.repeat(9 * 1024 * 1024))).toBe(false); });
  expect(result.current.baseline?.body).toBe('{}');
});
