import type { RequestDiagnostics } from '../types';
import { formatBytes } from '../lib/workspace';
import './request-history.css';

const outcomes: Record<RequestDiagnostics['outcome'], { label: string; hint: string }> = {
  response: { label: '已收到响应', hint: 'HTTP 4xx / 5xx 同样属于已收到响应，请结合状态码和正文判断。' },
  timeout: { label: '整体超时', hint: '检查地址、网络、服务耗时与超时设置；写操作超时后，先确认服务端结果。' },
  cancelled: { label: '已取消', hint: '取消仅停止本机等待，服务端可能仍在执行。' },
  connection: { label: '连接失败', hint: '检查域名或 IP、端口、网络与 TLS 证书。此分类不能单独证明是 DNS 或证书故障。' },
  body: { label: '正文接收失败', hint: '连接在响应接收期间出现异常，内容可能不完整。' },
  validation: { label: '配置检查未通过', hint: '检查环境绑定、变量、鉴权、上传文件与生产确认。' },
  transport: { label: '传输未完成', hint: '请求可能已送达；重发写操作前，先确认服务端执行结果。' },
};

export function RequestDiagnosticsPanel({ diagnostics }: { diagnostics?: RequestDiagnostics }) {
  if (!diagnostics) return <div className="request-diagnostics"><p className="muted">此记录未采集网络指标；重新发送后可查看。</p></div>;
  const outcome = outcomes[diagnostics.outcome] ?? outcomes.transport;
  const metrics: [string, string][] = [
    ['执行结果', outcome.label], ['总体耗时', `${diagnostics.totalMs} ms`],
    ...(diagnostics.preparationMs === undefined ? [] : [['准备配置', `${diagnostics.preparationMs} ms`] as [string, string]]),
    ...(diagnostics.headersMs === undefined ? [] : [['等待响应头', `${diagnostics.headersMs} ms`] as [string, string]]),
    ...(diagnostics.downloadMs === undefined ? [] : [['接收正文', `${diagnostics.downloadMs} ms`] as [string, string]]),
    ...(diagnostics.httpVersion ? [['HTTP 协议', diagnostics.httpVersion] as [string, string]] : []),
    ...(diagnostics.remoteAddress ? [['远端地址', diagnostics.remoteAddress] as [string, string]] : []),
    ...(diagnostics.receivedBytes === undefined ? [] : [['已接收大小', formatBytes(diagnostics.receivedBytes)] as [string, string]]),
  ];
  return <section className="request-diagnostics" aria-label="网络诊断">
    <dl>{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p>{outcome.hint}</p>
    <p className="muted">等待响应头包含连接、TLS 和请求上传；暂不单独采集 DNS / TCP / TLS 阶段。大小仅指已接收内容。</p>
  </section>;
}
