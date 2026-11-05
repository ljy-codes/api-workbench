import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Braces, ChevronsDownUp, Copy, ListCollapse, Minimize2, Trash2 } from 'lucide-react';
import { formatJson } from '../lib/json-format';
import { findJsonText } from '../lib/json-search';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { Dialog } from './Dialog';
import { JsonToolsSearch } from './JsonToolsSearch';
import './json-tools.css';

const JsonCompareTool = lazy(() => import('./JsonCompareTool').then(module => ({ default: module.JsonCompareTool })));
const JsonStringTool = lazy(() => import('./JsonStringTool').then(module => ({ default: module.JsonStringTool })));
const JsonExtractPanel = lazy(() => import('./JsonExtractPanel').then(module => ({ default: module.JsonExtractPanel })));
const tools = [
  { key: 'format', title: '格式化' },
  { key: 'compare', title: '双栏对比' },
  { key: 'string', title: '转义还原' },
  { key: 'extract', title: '字段提取' },
] as const;
type Tool = typeof tools[number]['key'];

/** Intentionally isolated from workspace, IPC, storage and application preferences.
 * Unmounting this dialog discards the entire draft, search and editor history. */
export default function JsonToolsDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [tool, setTool] = useState<Tool>('format');
  const [visited, setVisited] = useState<Set<Tool>>(() => new Set(['format']));
  const [text, setText] = useState('');
  const [removeNull, setRemoveNull] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [structured, setStructured] = useState(false);
  const [foldAction, setFoldAction] = useState<'collapse' | 'expand' | null>(null);
  const editor = useRef<CodeEditorHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const found = useMemo(() => findJsonText(text, query), [text, query]);
  const lines = useMemo(() => text ? text.split('\n').length : 0, [text]);
  const show = (next: Tool) => {
    setTool(next);
    setVisited(previous => previous.has(next) ? previous : new Set([...previous, next]));
  };
  const sharedSource = tool === 'format' || tool === 'extract';

  useEffect(() => {
    if (foldAction === 'collapse') editor.current?.collapseAll();
    else if (foldAction === 'expand') editor.current?.expandAll();
    setFoldAction(null);
  }, [foldAction, text]);

  const edit = (next: string) => {
    setText(next); setStructured(false); setActive(-1); setError(''); setMessage('');
  };
  const transform = (compact: boolean, collapse = false) => {
    try {
      const next = formatJson(text, { removeNull, compact });
      editor.current?.replaceValue(next);
      setText(next); setStructured(true); setActive(-1); setError('');
      setMessage(compact ? '已压缩为一行' : collapse ? '已按对象和数组收起，可点击折叠标记逐项审查' : '已格式化并展开');
      setFoldAction(collapse ? 'collapse' : 'expand');
    } catch (error) {
      setMessage('');
      setError(`JSON 处理失败，原文已保留。${error instanceof Error ? error.message : '请检查格式。'}`);
    }
  };
  const move = (direction: 1 | -1) => {
    if (!found.matches.length) return;
    const next = active < 0 ? direction === 1 ? 0 : found.matches.length - 1
      : (active + direction + found.matches.length) % found.matches.length;
    setActive(next); editor.current?.revealRange(found.matches[next]);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制完整内容（含折叠部分）'); setError('');
    } catch { setError('复制失败，请在编辑区选择后复制。'); setMessage(''); }
  };
  const clear = () => {
    edit(''); setQuery(''); setFoldAction(null);
    // Destroy CodeMirror's undo history as well as the visible document.
    setEditorKey(key => key + 1);
  };

  return <Dialog title="JSON 工具" onClose={onClose} className="json-tools-dialog">
    <section className="json-tools" aria-label="临时 JSON 工具" onKeyDownCapture={event => {
      if (sharedSource && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); searchInput.current?.select();
      } else if (sharedSource && event.key === 'Escape' && query) {
        event.preventDefault(); event.stopPropagation(); setQuery(''); setActive(-1);
      }
    }}>
      <div className="json-tools-intro">
        <div><Braces size={19} aria-hidden="true" /><p>整理、对比、提取，一处完成。<span>粘贴数据，处理后直接复制使用。</span></p></div>
        <span className="json-tools-ephemeral">临时处理 · 关闭即清空</span>
      </div>
      <div className="json-tools-tabs" role="tablist" aria-label="JSON 工具类型">
        {tools.map((item, index) => <button type="button" role="tab" key={item.key}
          id={`${id}-${item.key}`} aria-selected={tool === item.key} tabIndex={tool === item.key ? 0 : -1}
          aria-controls={`${id}-${item.key === 'extract' || item.key === 'format' ? 'source' : `${item.key}-panel`}`}
          onClick={() => show(item.key)} onKeyDown={event => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % tools.length;
            else if (event.key === 'ArrowLeft') next = (index + tools.length - 1) % tools.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tools.length - 1;
            else return;
            event.preventDefault();
            show(tools[next].key);
            document.getElementById(`${id}-${tools[next].key}`)?.focus();
          }}>{item.title}</button>)}
      </div>
      <div className={`json-tools-source${tool === 'extract' ? ' extracting' : ''}`} role="tabpanel"
        id={`${id}-source`} aria-labelledby={`${id}-${sharedSource ? tool : 'format'}`} hidden={!sharedSource}>
      <div className="json-tools-toolbar">
        <div className="json-tools-actions" role="group" aria-label="JSON 格式操作">
          <button type="button" className="primary" disabled={!text.trim()} onClick={() => transform(false)}><ListCollapse size={15} aria-hidden="true" />格式化展开</button>
          <button type="button" disabled={!text.trim()} onClick={() => transform(true)}><Minimize2 size={15} aria-hidden="true" />压缩一行</button>
          <button type="button" disabled={!text.trim()} onClick={() => transform(false, true)}><ChevronsDownUp size={15} aria-hidden="true" />收起模块</button>
        </div>
        <label className="json-tools-null" hidden={tool === 'extract'} title="仅在格式操作时去除对象中的 null 字段，保留数组中的 null 及 0、false、空字符串">
          <input type="checkbox" checked={removeNull} onChange={event => setRemoveNull(event.target.checked)} />去除 null 字段
        </label>
        <div className="json-tools-actions">
          <button type="button" disabled={!text.length} aria-label="复制 JSON" onClick={() => void copy()}><Copy size={15} aria-hidden="true" />复制</button>
          <button type="button" disabled={!text.length} aria-label="清空内容" onClick={clear}><Trash2 size={15} aria-hidden="true" />清空</button>
        </div>
      </div>
      <JsonToolsSearch ref={searchInput} query={query} count={found.matches.length} capped={found.capped} active={active}
        onChange={value => { setQuery(value); setActive(-1); }} onMove={move} />
      {error && <p className="json-tools-error" role="alert">{error}</p>}
      <div className="json-tools-editor">
        {!text && <div className="json-tools-placeholder" aria-hidden="true"><Braces size={32} /><strong>把 JSON 粘贴到这里</strong><span>默认保留 null · 自动清理末尾多余逗号</span></div>}
        <CodeEditor key={editorKey} ref={editor} value={text} isJson label="临时 JSON 内容"
          structuralFolding={structured} matches={found.matches} onChange={edit} />
      </div>
      {visited.has('extract') && <div className="json-tools-extract-slot" hidden={tool !== 'extract'}>
        <Suspense fallback={<p className="json-tool-loading" role="status">正在打开字段提取…</p>}>
          <JsonExtractPanel source={text} onUseResult={value => {
            editor.current?.replaceValue(value);
            edit(value);
            setStructured(true);
            setFoldAction('expand');
            show('format');
          }} />
        </Suspense>
      </div>}
      <footer className="json-tools-footer">
        <span role="status" aria-label="处理结果">{message || '内容仅在本窗口内存中处理'}</span>
        <span>{text.length.toLocaleString()} 字符 · {lines.toLocaleString()} 行</span>
      </footer>
      </div>
      {(['compare', 'string'] as const).map(key => <div className="json-tools-extra-panel" role="tabpanel"
        key={key} id={`${id}-${key}-panel`} aria-labelledby={`${id}-${key}`} hidden={tool !== key}>
        {visited.has(key) && <Suspense fallback={<p className="json-tool-loading" role="status">正在打开工具…</p>}>
          {key === 'compare' ? <JsonCompareTool /> : <JsonStringTool />}
        </Suspense>}
      </div>)}
    </section>
  </Dialog>;
}
