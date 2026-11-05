import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, History, RotateCcw, Trash2 } from 'lucide-react';
import type { RequestHistoryEntry } from '../types';
import { api, desktop } from '../lib/ipc';
import { errorMessage } from '../lib/workspace';
import { parseExactJson } from '../lib/json-exact';
import { buildInvestigationReport, type InvestigationReportOptions } from '../lib/investigation-report';
import { Dialog } from './Dialog';
import { ResponsePanel } from './ResponsePanel';
import { RequestDiagnosticsPanel } from './RequestDiagnosticsPanel';
import './request-history.css';

const ResponseDiff = lazy(() => import('./ResponseDiff').then(module => ({ default: module.ResponseDiff })));

export interface RequestHistoryDialogProps {
  entries: RequestHistoryEntry[]; projectName?: string; busy: boolean;
  onClose: () => void; onRestore: (id: string) => Promise<boolean>;
  onDelete: (id: string) => void; onClear: () => void;
}
function HistoryCompare({ entries }: { entries: RequestHistoryEntry[] }) {
  const result = useMemo(() => {
    if (entries.length !== 2) return { error: '在左侧勾选两条记录，即可比较响应 JSON。较早执行作为基准。' };
    if (entries.some(entry => !entry.response || entry.response.truncated)) return { error: '需要两份完整响应，无法比较失败或截断的记录。' };
    const [before, after] = [...entries].sort((a, b) => a.startedAt - b.startedAt);
    try {
      return { before, after, baseline: parseExactJson(before.response!.body), current: parseExactJson(after.response!.body) };
    } catch { return { error: '比较需要有效 JSON，每份最多 100 万字符、128 层、5 万节点。请使用原文查看其他响应。' }; }
  }, [entries]);
  if ('error' in result) return <p className="history-empty" role="status">{result.error}</p>;
  return <>
    <p className="history-compare-label">基准：{result.before!.request.name} · {result.before!.environmentName} · {new Date(result.before!.startedAt).toLocaleTimeString()}<br />
      当前：{result.after!.request.name} · {result.after!.environmentName} · {new Date(result.after!.startedAt).toLocaleTimeString()}</p>
    <Suspense fallback={<p role="status">正在加载对比…</p>}><ResponseDiff baseline={result.baseline} current={result.current} /></Suspense>
  </>;
}

function InvestigationReport({ entry }: { entry: RequestHistoryEntry }) {
  const [options, setOptions] = useState<InvestigationReportOptions>({});
  const [report, setReport] = useState<ReturnType<typeof buildInvestigationReport>>();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const update = (patch: InvestigationReportOptions) => {
    setOptions(previous => ({ ...previous, ...patch }));
    setReport(undefined); setMessage('');
  };
  return <div className="history-report">
    <p className="history-restore-hint">仅导出本次记录。默认不包含正文与响应 Headers；自动隐藏常见凭据，分享前请核对预览中的业务信息。</p>
    <label>问题现象<textarea aria-label="问题现象" maxLength={4000} disabled={saving} value={options.symptom ?? ''} onChange={event => update({ symptom: event.target.value })} placeholder="例如：开发环境正常，测试环境返回 502" /></label>
    <label>复现步骤<textarea aria-label="复现步骤" maxLength={8000} disabled={saving} value={options.steps ?? ''} onChange={event => update({ steps: event.target.value })} placeholder="补充操作过程与预期结果" /></label>
    <div className="history-report-options">
      <label><input type="checkbox" disabled={saving} checked={!!options.includeRequestBody} onChange={event => update({ includeRequestBody: event.target.checked })} />包含请求正文</label>
      <label><input type="checkbox" disabled={saving} checked={!!options.includeResponseBody} onChange={event => update({ includeResponseBody: event.target.checked })} />包含响应正文</label>
      <label><input type="checkbox" disabled={saving} checked={!!options.includeResponseHeaders} onChange={event => update({ includeResponseHeaders: event.target.checked })} />包含响应 Headers</label>
    </div>
    <div className="history-action-row">
      <button disabled={saving} onClick={() => {
        try { setReport(buildInvestigationReport(entry, options)); setMessage(''); }
        catch { setMessage('无法生成排查包，原始记录已保留。'); }
      }}>生成脱敏预览</button>
      <button disabled={!report || saving || !desktop} onClick={async () => {
        if (!report || savingRef.current) return;
        savingRef.current = true; setSaving(true); setMessage('');
        try {
          const path = await api.writeInvestigationReport(report.html);
          setMessage(path ? `排查包已保存：${path}` : '已取消保存。');
        } catch (error) { setMessage(`保存失败：${errorMessage(error)}`); }
        finally { savingRef.current = false; setSaving(false); }
      }}><FileDown size={14} />{saving ? '正在保存…' : '保存 HTML 排查包'}</button>
    </div>
    {!desktop && <p className="history-restore-hint">保存文件需要桌面版，浏览器预览可以查看生成内容。</p>}
    {message && <p role="status">{message}</p>}
    {report && <label>导出内容预览<textarea className="history-report-preview" aria-label="排查包内容预览" readOnly value={report.preview} /></label>}
  </div>;
}

export default function RequestHistoryDialog({ entries, projectName, busy, onClose, onRestore, onDelete, onClear }: RequestHistoryDialogProps) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [search, setSearch] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'details' | 'compare' | 'report'>('details');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(entry => (!environmentId || entry.environmentId === environmentId)
      && (!status || (status === 'ok' ? !!entry.response && entry.response.status < 400 : !!entry.error || !!entry.response && entry.response.status >= 400))
      && (!query || `${entry.request.name} ${entry.request.method} ${entry.request.path} ${entry.environmentName} ${entry.serviceName}`.toLowerCase().includes(query)));
  }, [entries, search, environmentId, status]);
  useEffect(() => {
    if (!visible.some(entry => entry.id === selectedId)) {
      if (selectedId) setSelectionNotice('所选记录已移除或不符合筛选条件，已更新显示。切换记录会清空该记录的未保存排查草稿。');
      setSelectedId(visible[0]?.id);
    }
  }, [visible, selectedId]);
  const selected = visible.find(entry => entry.id === selectedId) ?? visible[0];
  const compared = useMemo(() => compareIds.map(id => entries.find(entry => entry.id === id)).filter((entry): entry is RequestHistoryEntry => !!entry), [compareIds, entries]);
  const environments = [...new Map(entries.map(entry => [entry.environmentId, entry.environmentName])).entries()];
  return <Dialog title={`请求时间线${projectName ? ` · ${projectName}` : ''}`} onClose={onClose} wide className="request-history-dialog">
    <p className="history-intro">仅当前应用会话；关闭应用即清空。全工作区最多 50 条 / 16 MiB，自动淘汰最旧记录。这里展示当前项目，勾选两条可比较响应。</p>
    <div className="history-layout">
      <aside className="history-sidebar" aria-label="执行记录列表">
        <input autoFocus type="search" aria-label="搜索执行记录" placeholder="接口、路径、服务或环境" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="history-filters">
          <select aria-label="历史环境筛选" value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">所有环境</option>{environments.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select>
          <select aria-label="历史结果筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="">所有结果</option><option value="ok">HTTP &lt; 400</option><option value="error">错误 / HTTP ≥ 400</option></select>
        </div>
        <div className="history-action-row"><small>{visible.length} / {entries.length} 条记录</small><button className="text-button" disabled={!entries.length} onClick={onClear}>清空本项目</button></div>
        <div className="history-list">
          {!entries.length ? <p className="history-empty"><History size={22} /><br />还没有执行记录。<br />在桌面版发送一次请求后显示。</p>
            : !visible.length ? <p className="history-empty">没有匹配的记录。</p>
              : visible.map(entry => <div className="history-entry" key={entry.id} data-selected={entry.id === selected?.id} data-error={!!entry.error || (entry.response?.status ?? 0) >= 400}>
                <input type="checkbox" aria-label={`选择对比 ${entry.id}`} checked={compared.some(item => item.id === entry.id)}
                  disabled={!entry.response || entry.response.truncated || compared.length >= 2 && !compared.some(item => item.id === entry.id)}
                  onChange={event => setCompareIds(previous => event.target.checked ? [...compared.map(item => item.id), entry.id] : previous.filter(id => id !== entry.id))} />
                <button className="history-select" aria-label={`查看记录 ${entry.id}`} aria-pressed={selected?.id === entry.id} onClick={() => setSelectedId(entry.id)}>
                  <span className="history-entry-title"><span className="history-method">{entry.request.method}</span><strong className="ellipsis">{entry.request.name}</strong></span>
                  <small>{entry.environmentName} · {entry.response ? entry.response.status : entry.diagnostics?.outcome === 'cancelled' ? '已取消' : '未完成'} · {entry.diagnostics?.totalMs ?? entry.response?.durationMs ?? Math.max(0, entry.finishedAt - entry.startedAt)} ms</small>
                  <small>{new Date(entry.startedAt).toLocaleTimeString()} · {entry.request.path}</small>
                </button>
                <button className="icon-button" aria-label={`删除记录 ${entry.id}`} title="删除本条会话记录" onClick={() => onDelete(entry.id)}><Trash2 size={13} /></button>
              </div>)}
        </div>
      </aside>
      <section className="history-detail" aria-label="执行记录详情">
        <header className="history-detail-header"><strong>{selected?.request.name ?? '执行记录'}</strong><button disabled={!selected || busy} onClick={async () => { if (selected && await onRestore(selected.id) && mounted.current) onClose(); }}><RotateCcw size={14} />恢复为草稿</button></header>
        <div className="history-mode-buttons" aria-label="记录操作">
          <button aria-pressed={mode === 'details'} onClick={() => setMode('details')}>记录详情</button>
          <button aria-pressed={mode === 'compare'} onClick={() => setMode('compare')}>响应对比（{compared.length}/2）</button>
          <button aria-pressed={mode === 'report'} disabled={!selected} onClick={() => setMode('report')}>问题排查包</button>
        </div>
        <div className="history-detail-body">
          {selectionNotice && <p className="history-restore-hint" role="status">{selectionNotice}</p>}
          {mode === 'compare' ? <HistoryCompare entries={compared} />
            : selected ? mode === 'report' ? <InvestigationReport key={selected.id} entry={selected} />
              : <>
                <p className="history-restore-hint">恢复只生成未发送草稿。鉴权、敏感 Header / Query、变量和服务公共配置沿用当前值；缺少当前值的历史凭据清空并禁用，变量占位符可保留。临时变量不恢复，文件需重新选择。</p>
                <RequestDiagnosticsPanel diagnostics={selected.diagnostics ?? selected.response?.diagnostics} />
                <ResponsePanel key={selected.id} execution={{ id: selected.id, requestId: selected.request.id, requestName: selected.request.name, environment: selected.environmentName,
                  running: false, response: selected.response, error: selected.error, diagnostics: selected.diagnostics }} />
                <details className="history-template"><summary>查看提交时的请求模板（仅本机）</summary><pre>{JSON.stringify(selected.request, null, 2)}</pre></details>
              </>
              : <p className="history-empty">选择一条记录查看详情。</p>}
        </div>
      </section>
    </div>
  </Dialog>;
}
