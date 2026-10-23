import { useEffect, useMemo, useState } from 'react';
import { Copy, Crosshair } from 'lucide-react';
import { formatJsonPath, jsonRange, parseJsonPath, resolveJsonPath, type JsonPath, type JsonRange } from '../lib/json-inspection';
import './json-inspection.css';

export function JsonInspector({ value, text, selectedPath, onLocate }: {
  value: unknown; text: string; selectedPath?: JsonPath; onLocate: (range: JsonRange) => void;
}) {
  const [input, setInput] = useState('$');
  const [path, setPath] = useState<JsonPath>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (selectedPath) {
      setPath(selectedPath); setInput(formatJsonPath(selectedPath)); setError(''); setMessage('');
    }
  }, [selectedPath]);
  const target = useMemo(() => resolveJsonPath(value, path), [value, path]);
  const locate = () => {
    const next = parseJsonPath(input);
    if (!next) { setError('路径格式不正确，请使用 $.data[0].name 或 $["特殊字段"]。'); return; }
    if (!resolveJsonPath(value, next).found) { setError('该字段不存在。'); return; }
    const range = jsonRange(text, next);
    if (!range) { setError('无法定位该字段。'); return; }
    setPath(next); setInput(formatJsonPath(next)); setError(''); setMessage(''); onLocate(range);
  };
  const copy = async (kind: 'path' | 'value' | 'object') => {
    try {
      let content = formatJsonPath(path);
      if (kind !== 'path') {
        let container = path;
        if (kind === 'object') {
          while (container.length) {
            const found = resolveJsonPath(value, container);
            if (found.found && found.value !== null && typeof found.value === 'object' && !Array.isArray(found.value)) break;
            container = container.slice(0, -1);
          }
        }
        const range = jsonRange(text, kind === 'value' ? path : container);
        if (!range) throw new Error('missing');
        content = text.slice(range.from, range.to);
        const lineStart = text.lastIndexOf('\n', range.from - 1) + 1;
        const indent = text.slice(lineStart, range.from).match(/^[ \t]*/)?.[0] ?? '';
        if (indent) content = content.split('\n' + indent).join('\n');
      }
      await navigator.clipboard.writeText(content);
      setMessage('已复制'); setError('');
    } catch { setError('复制失败，请在正文中选择后复制。'); }
  };
  return <div className="json-inspector">
    <form className="json-path-form" onSubmit={event => { event.preventDefault(); locate(); }}>
      <Crosshair size={14} aria-hidden="true" />
      <input aria-label="JSON 字段路径" placeholder="$.data[0].name" value={input} onChange={event => setInput(event.target.value)} spellCheck={false} />
      <button type="submit">定位字段</button>
    </form>
    <div className="json-inspector-actions">
      <span className="muted">点击正文中的字段也可查看路径</span>
      <button className="icon-button" aria-label="复制字段路径" title="复制字段路径" onClick={() => void copy('path')}><Copy size={13} />路径</button>
      <button className="icon-button" aria-label="复制字段值" title="复制字段值（JSON）" disabled={!target.found} onClick={() => void copy('value')}>值</button>
      <button className="icon-button" aria-label="复制所在对象" title="复制字段所在对象" disabled={!target.found} onClick={() => void copy('object')}>对象</button>
      {message && <span role="status">{message}</span>}
    </div>
    {error && <p className="inspection-error" role="alert">{error}</p>}
  </div>;
}
