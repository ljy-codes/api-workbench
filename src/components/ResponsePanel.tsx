import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Braces, Check, Clock3, Copy, Info, LoaderCircle, Search, Trash2, X } from 'lucide-react';
import type { Execution } from '../hooks/useWorkbench';
import type { BodyMatch } from './CodeEditor';
import { formatBytes } from '../lib/workspace';

const CodeEditor = lazy(() => import('./CodeEditor'));

export function ResponsePanel({ execution, onClear }: { execution?: Execution; onClear?: () => void }) {
  const [tab, setTab] = useState('body');
  const [format, setFormat] = useState('json');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const response = execution?.response;
  const { body, validJson } = useMemo(() => {
    const raw = response?.body ?? '';
    try { const parsed: unknown = JSON.parse(raw); return { body: format === 'json' ? JSON.stringify(parsed, null, 2) : raw, validJson: true }; }
    catch { return { body: raw, validJson: false }; }
  }, [response?.body, format]);
  const found = useMemo(() => {
    if (!search) return { matches: [], count: 0, capped: false };
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches: BodyMatch[] = [];
    // Bound decorations for large responses and short queries; CodeMirror virtualizes the text.
    for (const match of body.matchAll(expression)) {
      if (matches.length >= 1000) break;
      matches.push({ from: match.index!, to: match.index! + match[0].length });
    }
    return { matches, count: matches.length, capped: matches.length === 1000 };
  }, [body, search]);
  const closeSearch = () => { setSearchOpen(false); setSearch(''); };
  return <section className="response-panel" aria-label="接口响应" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && response) {
      event.preventDefault(); setTab('body'); setSearchOpen(true); searchInput.current?.focus();
    } else if (event.key === 'Escape' && searchOpen) { event.preventDefault(); closeSearch(); }
  }}>
    <header className="response-heading">
      <div className="response-title">
        {response ? <div className="response-metrics"><span className={response.status < 400 ? 'success-badge' : 'error-badge'}>{response.status} {response.statusText}</span><span><Clock3 size={12} />{response.durationMs} ms</span><span>已接收 {formatBytes(response.sizeBytes)}</span></div> : <strong>响应</strong>}
        {execution?.running && <span className="muted"><LoaderCircle className="spin" size={13} />请求进行中</span>}
      </div>
      <div className="response-heading-actions">
        {execution && <span className="response-environment ellipsis" title="本次响应的执行环境">{response?.environmentName ?? execution.environment}</span>}
        {execution && <button type="button" className="icon-button" aria-label="执行详情" title="执行详情" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(open => !open)}><Info size={14} /></button>}
        {onClear && <button type="button" className="icon-button" aria-label="清除当前响应" title="清除当前接口在当前环境的响应" disabled={!execution || execution.running} onClick={onClear}><Trash2 size={14} /></button>}
      </div>
    </header>
    {execution && detailsOpen && <dl className="execution-context"><dt>接口</dt><dd>{execution.requestName}</dd><dt>执行 ID</dt><dd><code>{execution.id}</code></dd>{response && <><dt>地址</dt><dd><code>{response.url}</code></dd></>}</dl>}
    {execution?.cancelRequested && <p className="warning-line">已请求取消；服务端可能仍在执行，此操作不代表回滚。</p>}
    {execution?.error && <div className="error-box" role="alert"><strong>请求未完成</strong><p>{execution.error}</p></div>}
    {!response && !execution?.error && <div className="response-empty"><div className="empty-icon"><Braces size={26} /></div><h3>{execution?.running ? '正在等待响应' : '响应将在这里呈现'}</h3><p>{execution?.running ? '可以继续查看其他接口，结果始终归属本次执行。' : '配置环境与接口，在桌面版发送你的第一个请求。'}</p>{!execution && <span className="shortcut-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送请求</span>}</div>}
    {response && <>
      <div className="response-toolbar">
        <div role="tablist" aria-label="响应内容">
          <button role="tab" aria-selected={tab === 'body'} onClick={() => setTab('body')}>正文</button>
          <button role="tab" aria-selected={tab === 'headers'} onClick={() => setTab('headers')}>Headers <small>{response.headers.length}</small></button>
        </div>
        {tab === 'body' && <div className="response-actions">
          <select aria-label="响应显示格式" value={format} onChange={e => setFormat(e.target.value)}><option value="json">{validJson ? 'JSON' : 'Text'}</option><option value="text">原始文本</option></select>
          <button className="icon-button" aria-label="查找响应正文" title="查找 · Ctrl/Cmd+F" aria-expanded={searchOpen} onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true); }}><Search size={14} /></button>
          <button className="icon-button" aria-label="复制响应正文" title="复制原始响应正文" onClick={async () => { try { await navigator.clipboard.writeText(response.body); setCopied(true); setCopyError(''); } catch { setCopyError('复制失败，请手动选择正文复制。'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>}
      </div>
      {response.truncated && <p className="warning-line">响应不完整：超过接收上限，已停止接收。以下仅为已接收内容，大小不代表完整响应。</p>}
      {copyError && <p role="alert">{copyError}</p>}
      {tab === 'body' ? <>
        {searchOpen && <div className="response-search">
          <input ref={searchInput} autoFocus type="search" aria-label="搜索响应正文" placeholder="查找 JSON / 文本" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <span role="status">{found.capped ? '至少 ' : ''}{found.count} 处匹配{found.capped ? '（仅高亮前 1000 处）' : ''}</span>}
          <button className="icon-button" aria-label="关闭响应查找" title="关闭查找 · Esc" onClick={closeSearch}><X size={13} /></button>
        </div>}
        {body ? <div className="response-code"><Suspense fallback={<div className="table-empty">正在加载响应…</div>}><CodeEditor value={body} isJson={validJson && format === 'json'} readOnly label="响应正文" matches={found.matches} /></Suspense></div> : <div className="table-empty">（空响应）</div>}
      </> : <div className="response-headers"><table className="headers-table"><thead><tr><th>名称</th><th>值</th></tr></thead><tbody>{response.headers.map(h => <tr key={h.id}><td>{h.key}</td><td>{h.value}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
