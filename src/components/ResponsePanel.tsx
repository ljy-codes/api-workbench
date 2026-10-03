import { useMemo, useState, type ReactNode } from 'react';
import { Braces, Check, Clock3, Copy, CornerDownLeft, LoaderCircle, Trash2 } from 'lucide-react';
import type { Execution } from '../hooks/useWorkbench';
import { formatBytes } from '../lib/workspace';

export function ResponsePanel({ execution, onClear }: { execution?: Execution; onClear?: () => void }) {
  const [tab, setTab] = useState('body');
  const [format, setFormat] = useState('json');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [search, setSearch] = useState('');
  const response = execution?.response;
  const { body, validJson } = useMemo(() => {
    const raw = response?.body ?? '';
    try { const parsed: unknown = JSON.parse(raw); return { body: format === 'json' ? JSON.stringify(parsed, null, 2) : raw, validJson: true }; }
    catch { return { body: raw, validJson: false }; }
  }, [response?.body, format]);
  const found = useMemo(() => {
    if (!search) return { content: body, count: 0, capped: false };
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const content: ReactNode[] = [];
    let cursor = 0, count = 0;
    // Avoid producing millions of React nodes for large responses and short queries.
    for (const match of body.matchAll(expression)) {
      if (count >= 1000) break;
      const index = match.index!;
      content.push(body.slice(cursor, index), <mark key={index}>{match[0]}</mark>);
      cursor = index + match[0].length; count++;
    }
    content.push(body.slice(cursor));
    return { content, count, capped: count === 1000 };
  }, [body, search]);
  return <section className="response-panel" aria-label="接口响应">
    <header className="response-heading"><div className="response-title"><CornerDownLeft size={16} /><strong>响应</strong>{execution?.running && <span className="muted"><LoaderCircle className="spin" size={13} />请求进行中</span>}</div><div className="response-heading-actions">{response && <div className="response-metrics"><span className={response.status < 400 ? 'success-badge' : 'error-badge'}>{response.status} {response.statusText}</span><span><Clock3 size={12} />{response.durationMs} ms</span><span>已接收 {formatBytes(response.sizeBytes)}</span></div>}{onClear && <button type="button" className="icon-button" aria-label="清除当前响应" title="清除当前接口在当前环境的响应" disabled={!execution || execution.running} onClick={onClear}><Trash2 size={14} /></button>}</div></header>
    {execution && <div className="execution-context"><span>执行环境：<strong>{execution.environment}</strong></span><span>{execution.requestName}</span><code title={execution.id}>ID {execution.id.slice(0, 8)}</code></div>}
    {execution?.cancelRequested && <p className="warning-line">已请求取消；服务端可能仍在执行，此操作不代表回滚。</p>}
    {execution?.error && <div className="error-box" role="alert"><strong>请求未完成</strong><p>{execution.error}</p></div>}
    {!response && !execution?.error && <div className="response-empty"><div className="empty-icon"><Braces size={26} /></div><h3>{execution?.running ? '正在等待响应' : '响应将在这里呈现'}</h3><p>{execution?.running ? '可以继续查看其他接口，结果始终归属本次执行。' : '配置环境与接口，在桌面版发送你的第一个请求。'}</p>{!execution && <span className="shortcut-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送请求</span>}</div>}
    {response && <><div className="response-toolbar"><div role="tablist" aria-label="响应内容"><button role="tab" aria-selected={tab === 'body'} onClick={() => setTab('body')}>正文</button><button role="tab" aria-selected={tab === 'headers'} onClick={() => setTab('headers')}>Headers <small>{response.headers.length}</small></button></div>{tab === 'body' && <div className="response-actions"><select aria-label="响应显示格式" value={format} onChange={e => setFormat(e.target.value)}><option value="json">JSON 格式</option><option value="text">原始文本</option></select><button className="icon-button" aria-label="复制响应正文" onClick={async () => { try { await navigator.clipboard.writeText(response.body); setCopied(true); setCopyError(''); } catch { setCopyError('复制失败，请手动选择正文复制。'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>}</div>{response.truncated && <p className="warning-line">响应不完整：超过接收上限，已停止接收。以下仅为已接收内容，大小不代表完整响应。</p>}{copyError && <p role="alert">{copyError}</p>}{tab === 'body' ? <><div className="response-format">{validJson ? 'JSON' : 'TEXT'} · {response.environmentName}</div><div className="response-search"><label>查找<input type="search" aria-label="搜索响应正文" placeholder="搜索 JSON / 文本（不区分大小写）" value={search} onChange={e => setSearch(e.target.value)} /></label>{search && <span role="status">{found.capped ? '至少 ' : ''}{found.count} 处匹配{found.capped ? '（仅高亮前 1000 处）' : ''}</span>}</div><pre className="response-body">{body ? found.content : '（空响应）'}</pre></> : <table className="headers-table"><thead><tr><th>名称</th><th>值</th></tr></thead><tbody>{response.headers.map(h => <tr key={h.id}><td>{h.key}</td><td>{h.value}</td></tr>)}</tbody></table>}</>}
  </section>;
}
