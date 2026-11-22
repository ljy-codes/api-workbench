import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Filter, Replace, Trash2 } from 'lucide-react';
import { extractJsonValues, type ExtractionFormat } from '../lib/json-toolbox';
import CodeEditor from './CodeEditor';

interface Extraction {
  source: string;
  path: string;
  format: ExtractionFormat;
  deduplicate: boolean;
  text: string;
  count: number;
  revision: number;
}

export function JsonExtractPanel({ source, onUseResult }: {
  source: string;
  onUseResult: (text: string) => void;
}) {
  const hint = useId();
  const revision = useRef(0);
  const [path, setPath] = useState('$');
  const [format, setFormat] = useState<ExtractionFormat>('json');
  const [deduplicate, setDeduplicate] = useState(false);
  const [result, setResult] = useState<Extraction>();
  const [feedback, setFeedback] = useState<{ error?: string; message?: string }>({});
  useEffect(() => {
    revision.current++;
    setResult(undefined);
    setFeedback({});
    // Invalidate pending clipboard feedback on source changes and unmount.
    return () => { revision.current++; };
  }, [source]);
  const valid = result?.source === source && result.path === path
    && result.format === format && result.deduplicate === deduplicate;
  const reset = () => { revision.current++; setResult(undefined); setFeedback({}); };
  const extract = () => {
    const current = ++revision.current;
    try {
      const next = extractJsonValues(source, path, { format, deduplicate });
      setResult({ ...next, source, path, format, deduplicate, revision: current });
      setFeedback({});
    } catch (error) {
      setResult(undefined);
      setFeedback({ error: `提取失败，原文已保留。${error instanceof Error ? error.message : '请检查 JSON 和路径。'}` });
    }
  };
  const copy = async () => {
    if (!valid || !result) return;
    const current = revision.current;
    try {
      await navigator.clipboard.writeText(result.text);
      if (revision.current === current) setFeedback({ message: '已复制完整提取结果' });
    } catch {
      if (revision.current === current) setFeedback({ error: '复制失败，请在结果区选择后复制，或重试。' });
    }
  };

  return <section className="json-extract-panel" aria-label="字段批量提取">
    <form className="json-extract-controls" onSubmit={event => { event.preventDefault(); extract(); }}>
      <label className="json-extract-path">
        <span>提取路径</span>
        <input value={path} spellCheck={false} aria-describedby={hint}
          placeholder="$.data.list[*].id" onChange={event => { setPath(event.target.value); reset(); }} />
      </label>
      <label>
        <span>输出格式</span>
        <select value={format} onChange={event => { setFormat(event.target.value as ExtractionFormat); reset(); }}>
          <option value="json">JSON 数组</option>
          <option value="lines">逐行文本</option>
          <option value="csv">逗号分隔（CSV）</option>
          <option value="sql">SQL IN</option>
        </select>
      </label>
      <label className="json-tools-null">
        <input type="checkbox" checked={deduplicate} onChange={event => { setDeduplicate(event.target.checked); reset(); }} />
        结果去重
      </label>
      <button type="submit" className="primary" disabled={!source.trim() || !path.trim()}>
        <Filter size={14} aria-hidden="true" />提取字段
      </button>
    </form>
    <p className="json-extract-hint" id={hint}>
      示例：<code>$.data.list[*].id</code> 提取列表全部 id；支持字段、下标、[*] 和引号字段，不支持过滤表达式或递归查询。
      {format === 'sql' && ' SQL IN 仅生成文本，不执行；没有匹配项时不会生成空 IN。'}
    </p>
    {feedback.error && <p className="json-tools-error" role="alert">{feedback.error}</p>}
    <div className="json-extract-result-heading">
      <span>提取结果</span>
      <div className="json-tools-actions">
        <button type="button" disabled={!valid} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />复制提取结果</button>
        <button type="button" disabled={!valid || format !== 'json'} onClick={() => result && onUseResult(result.text)}>
          <Replace size={14} aria-hidden="true" />用结果替换原文
        </button>
        <button type="button" disabled={!result && !feedback.error} onClick={reset}><Trash2 size={14} aria-hidden="true" />清空提取</button>
      </div>
    </div>
    <div className="json-extract-result">
      <CodeEditor key={valid ? result.revision : 'empty'} value={valid ? result.text : ''}
        isJson={format === 'json'} readOnly label="提取结果" />
    </div>
    <p className="json-extract-summary" role="status">
      {feedback.message || (valid ? `已提取 ${result.count} 项${result.count === 0 ? '，没有匹配字段' : ''}`
        : '在上方粘贴 JSON，输入路径后提取；修改原文或规则后需重新提取。')}
    </p>
  </section>;
}
