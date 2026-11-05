import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RequestDiagnosticsPanel } from './RequestDiagnosticsPanel';

afterEach(cleanup);
it('区分未采集与真实零毫秒，不伪造独立 DNS/TLS 阶段', () => {
  render(<RequestDiagnosticsPanel diagnostics={{ outcome: 'response', totalMs: 12, preparationMs: 0, headersMs: 7, downloadMs: 5, receivedBytes: 10, httpVersion: 'HTTP/1.1' }} />);
  expect(screen.getByText('0 ms')).toBeTruthy();
  expect(screen.getByText('7 ms')).toBeTruthy();
  expect(screen.getByText('HTTP/1.1')).toBeTruthy();
  expect(screen.getByText(/连接、TLS 和请求上传/)).toBeTruthy();
});
it('旧缓存未采集时明确说明，连接失败给出对应检查方向', () => {
  const { rerender } = render(<RequestDiagnosticsPanel />);
  expect(screen.getByText(/未采集/)).toBeTruthy();
  rerender(<RequestDiagnosticsPanel diagnostics={{ outcome: 'connection', totalMs: 8 }} />);
  expect(screen.getByText('连接失败')).toBeTruthy();
  expect(screen.getByText(/证书/)).toBeTruthy();
  expect(screen.queryByText('0 ms')).toBeNull();
});
