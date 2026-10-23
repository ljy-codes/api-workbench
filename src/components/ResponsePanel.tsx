import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Braces, Check, ChevronsDownUp, ChevronsUpDown, Clock3, Copy, Crosshair, Info, LoaderCircle, Search, Trash2, X } from 'lucide-react';
import type { Execution } from '../hooks/useWorkbench';
import type { ResponseBaseline } from '../hooks/useResponseBaselines';
import { useJsonDocument } from '../hooks/useJsonDocument';
import type { BodyMatch, CodeEditorHandle } from './CodeEditor';
import { formatBytes } from '../lib/workspace';
import { jsonNodeAt, jsonRange, type JsonPath, type JsonRange } from '../lib/json-inspection';
import { JsonInspector } from './JsonInspector';

const CodeEditor = lazy(() => import('./CodeEditor'));
const JsonArrayTable = lazy(() => import('./JsonArrayTable').then(module => ({ default: module.JsonArrayTable })));
const ResponseDiff = lazy(() => import('./ResponseDiff').then(module => ({ default: module.ResponseDiff })));

export function ResponsePanel({ execution, onClear, baseline, onSaveBaseline, onClearBaseline }: {
  execution?: Execution; onClear?: () => void; baseline?: ResponseBaseline;
  onSaveBaseline?: (body: string) => boolean; onClearBaseline?: () => void;
}) {
  const [tab, setTab] = useState('body');
  const [format, setFormat] = useState('json');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<JsonPath>();
  const [reveal, setReveal] = useState<JsonRange>();
  const [baselineError, setBaselineError] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const editor = useRef<CodeEditorHandle>(null);
  const response = execution?.response;
  const document = useJsonDocument(response?.body ?? '');
  const baselineDocument = useJsonDocument(format === 'compare' ? baseline?.body ?? '' : '');
  const { validJson } = document;
  const body = format === 'text' ? response?.body ?? '' : document.formatted;
  const canInspect = validJson && !response?.truncated;
  const showCode = format === 'json' || format === 'text';
  const found = useMemo(() => {
    if (!search || !showCode || !searchOpen) return { matches: [], count: 0, capped: false };
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches: BodyMatch[] = [];
    // Bound decorations for large responses and short queries; CodeMirror virtualizes the text.
    for (const match of body.matchAll(expression)) {
      if (matches.length >= 1000) break;
      matches.push({ from: match.index!, to: match.index! + match[0].length });
    }
    return { matches, count: matches.length, capped: matches.length === 1000 };
  }, [body, search, showCode, searchOpen]);
  const closeSearch = () => { setSearchOpen(false); setSearch(''); };
  const openSearch = () => {
    setTab('body'); if (!showCode) setFormat('json');
    setSearchOpen(true); searchInput.current?.focus();
  };
  const locatePath = (path: JsonPath) => {
    const range = jsonRange(document.formatted, path);
    if (!range) return;
    setSelectedPath(path); setReveal(range); setFormat('json'); setInspectorOpen(true);
  };
  return <section className="response-panel" aria-label="接口响应" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && response) {
      event.preventDefault(); openSearch();
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
          <select aria-label="响应显示格式" value={format} onChange={e => { setFormat(e.target.value); setReveal(undefined); }}>
            <option value="json">{document.loading ? '处理中…' : validJson ? 'JSON' : 'Text'}</option>
            <option value="text">原始文本</option>
            {canInspect && <><option value="table">数组表格</option><option value="compare">响应对比</option></>}
          </select>
          {validJson && format === 'json' && <>
            <button type="button" className="icon-button" aria-label="全部收起响应 JSON" title="全部收起 · 保留根字段" onClick={() => editor.current?.collapseAll()}><ChevronsDownUp size={14} /></button>
            <button type="button" className="icon-button" aria-label="全部展开响应 JSON" title="全部展开" onClick={() => editor.current?.expandAll()}><ChevronsUpDown size={14} /></button>
          </>}
          {canInspect && format === 'json' && <button className="icon-button" aria-label="JSON 字段定位" title="字段路径与复制" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(open => !open)}><Crosshair size={14} /></button>}
          <button className="icon-button" aria-label="查找响应正文" title="查找 · Ctrl/Cmd+F" aria-expanded={searchOpen && showCode} onClick={() => { if (searchOpen && showCode) closeSearch(); else openSearch(); }}><Search size={14} /></button>
          <button className="icon-button" aria-label="复制响应正文" title="复制原始响应正文" onClick={async () => { try { await navigator.clipboard.writeText(response.body); setCopied(true); setCopyError(''); } catch { setCopyError('复制失败，请手动选择正文复制。'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>}
      </div>
      {response.truncated && <p className="warning-line">响应不完整：超过接收上限，已停止接收。以下仅为已接收内容，大小不代表完整响应。</p>}
      {document.notice && <p className="warning-line">{document.notice}</p>}
      {copyError && <p role="alert">{copyError}</p>}
      {tab === 'body' ? <>
        {searchOpen && showCode && <div className="response-search">
          <input ref={searchInput} autoFocus type="search" aria-label="搜索响应正文" placeholder="查找 JSON / 文本" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <span role="status">{found.capped ? '至少 ' : ''}{found.count} 处匹配{found.capped ? '（仅高亮前 1000 处）' : ''}</span>}
          <button className="icon-button" aria-label="关闭响应查找" title="关闭查找 · Esc" onClick={closeSearch}><X size={13} /></button>
        </div>}
        {canInspect && format === 'json' && inspectorOpen && <JsonInspector value={document.value} text={body} selectedPath={selectedPath} onLocate={range => editor.current?.revealRange(range)} />}
        {format === 'table' && canInspect ? <Suspense fallback={<div className="table-empty">正在加载数组…</div>}><JsonArrayTable value={document.value} onLocate={locatePath} /></Suspense>
          : format === 'compare' && canInspect ? <>
            <div className="response-baseline">
              <span>{baseline ? `基准已保存 · ${new Date(baseline.savedAt).toLocaleTimeString()} · 仅当前会话` : '尚未设置比较基准，先保存当前响应，再发送一次请求。'}</span>
              {onSaveBaseline && <button disabled={execution?.running} onClick={() => {
                if (!onSaveBaseline(response.body)) setBaselineError('基准正文超过 16 MiB 内存限制，未保存。');
                else setBaselineError('');
              }}>{baseline ? '更新对比基准' : '设为对比基准'}</button>}
              {baseline && onClearBaseline && <button onClick={onClearBaseline}>清除基准</button>}
            </div>
            {baselineError && <p className="inspection-error" role="alert">{baselineError}</p>}
            {baseline && (baselineDocument.loading ? <div className="table-empty">正在处理比较基准…</div> : baselineDocument.validJson
              ? <Suspense fallback={<div className="table-empty">正在加载对比…</div>}><ResponseDiff baseline={baselineDocument.value} current={document.value} /></Suspense>
              : <p className="warning-line">比较基准无法解析，请重新设置。{baselineDocument.notice}</p>)}
          </> : document.loading && format !== 'text' ? <div className="table-empty" role="status"><LoaderCircle size={16} className="spin" /> 正在后台处理 JSON，可切换原始文本查看…</div>
            : body ? <div className="response-code"><Suspense fallback={<div className="table-empty">正在加载响应…</div>}><CodeEditor ref={editor} value={body} isJson={validJson && format === 'json'} readOnly label="响应正文" matches={found.matches} reveal={reveal}
              onSelectPosition={inspectorOpen && canInspect && format === 'json' ? position => {
                const node = jsonNodeAt(body, position);
                if (node) setSelectedPath(node.path);
              } : undefined} /></Suspense></div> : <div className="table-empty">（空响应）</div>}
      </> : <div className="response-headers"><table className="headers-table"><thead><tr><th>名称</th><th>值</th></tr></thead><tbody>{response.headers.map(h => <tr key={h.id}><td>{h.key}</td><td>{h.value}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
