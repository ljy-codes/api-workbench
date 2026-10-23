import { useId, useMemo, useState } from 'react';
import { compareJson, type JsonChange } from '../lib/json-diff';
import './response-diff.css';

export interface ResponseDiffProps {
  baseline: unknown;
  current: unknown;
}

const PAGE_SIZE = 50;
const MAX_CHANGES = 1000;
const MAX_NODES = 20_000;
const PREVIEW_LENGTH = 240;
const EXPANDED_LENGTH = 20_000;
const KIND_LABELS: Record<JsonChange['kind'], string> = {
  added: '新增', removed: '删除', changed: '修改',
};

// Commas in bracket-quoted keys belong to the path, not to the rule separator.
function parseIgnoreInput(input: string): string[] {
  const rules: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === ',' || char === '，' || char === '\n')) {
      rules.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  rules.push(input.slice(start).trim());
  return [...new Set(rules.filter(Boolean))];
}

type ValueWork = { value: unknown; depth: number } | { text: string };

function* containerContents(value: object, depth: number): Generator<ValueWork> {
  const array = Array.isArray(value);
  yield { text: array ? '[' : '{' };
  let first = true;
  if (array) {
    for (let index = 0; index < value.length; index++) {
      if (!first) yield { text: ',' };
      first = false;
      yield { value: value[index], depth: depth + 1 };
    }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!first) yield { text: ',' };
      first = false;
      // Limit even a single huge key before stringification.
      yield { value: key, depth: depth + 1 };
      yield { text: ':' };
      yield { value: (value as Record<string, unknown>)[key], depth: depth + 1 };
    }
  }
  yield { text: array ? ']' : '}' };
}

// Avoid full JSON.stringify: added/removed values can be enormous, deep, or cyclic.
function formatValue(value: unknown, maxLength: number): { text: string; truncated: boolean } {
  const stack: Iterator<ValueWork>[] = [[{ value, depth: 0 }][Symbol.iterator]()];
  const seen = new WeakSet<object>();
  let text = '';
  let nodes = 0;
  let truncated = false;
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if (++nodes > 5000) { truncated = true; break; }
    const work = next.value;
    let token: string;
    if ('text' in work) token = work.text;
    else if (work.value !== null && typeof work.value === 'object') {
      if (work.depth >= 128 || seen.has(work.value)) { truncated = true; break; }
      seen.add(work.value);
      stack.push(containerContents(work.value, work.depth));
      continue;
    } else if (typeof work.value === 'string') {
      token = JSON.stringify(work.value.slice(0, maxLength));
      if (work.value.length > maxLength) truncated = true;
    } else token = String(work.value);
    const remaining = maxLength - text.length;
    text += token.slice(0, remaining);
    if (token.length > remaining || truncated) { truncated = true; break; }
  }
  return { text: truncated ? `${text}…` : text, truncated };
}

function ValuePreview({ value, label, path }: { value: unknown; label: string; path: string }) {
  const [expansion, setExpansion] = useState({ source: value, open: false });
  const expanded = Object.is(expansion.source, value) && expansion.open;
  const formatted = useMemo(
    () => formatValue(value, expanded ? EXPANDED_LENGTH : PREVIEW_LENGTH),
    [value, expanded],
  );
  return <div className="response-diff-value">
    <dt>{label}</dt>
    <dd>
      <pre>{formatted.text}</pre>
      {(formatted.truncated || expanded) && <button
        type="button"
        aria-label={`${expanded ? '收起' : '展开'}${label} ${path}`}
        aria-expanded={expanded}
        onClick={() => setExpansion({ source: value, open: !expanded })}
      >{expanded ? '收起值' : '展开值'}</button>}
      {expanded && formatted.truncated && <p className="response-diff-hint">值过长或过深，展开后仍为部分内容（最多 20000 字符、128 层）。</p>}
    </dd>
  </div>;
}

export function ResponseDiff({ baseline, current }: ResponseDiffProps) {
  const hintId = useId();
  const matchingId = useId();
  const [ignoreInput, setIgnoreInput] = useState('');
  const [ignore, setIgnore] = useState<string[]>([]);
  const [matchById, setMatchById] = useState(false);
  const result = useMemo(
    () => compareJson(baseline, current, { ignore, matchById, maxChanges: MAX_CHANGES, maxNodes: MAX_NODES }),
    [baseline, current, ignore, matchById],
  );
  const [pagination, setPagination] = useState({ result, page: 0 });
  // A new result starts on page one synchronously, including response refreshes.
  const page = pagination.result === result ? pagination.page : 0;
  const pages = Math.max(1, Math.ceil(result.changes.length / PAGE_SIZE));
  const changes = result.changes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return <section className="response-diff" aria-label="响应 JSON 比较">
    <form className="response-diff-controls" onSubmit={event => {
      event.preventDefault();
      setIgnore(parseIgnoreInput(ignoreInput));
    }}>
      <label className="response-diff-ignore">
        <span>忽略字段或路径</span>
        <input value={ignoreInput} onChange={event => setIgnoreInput(event.target.value)}
          aria-describedby={hintId} placeholder="timestamp, $.data.updatedAt" />
      </label>
      <button type="submit">应用忽略规则</button>
      <label className="response-diff-match">
        <input type="checkbox" checked={matchById} aria-describedby={matchingId}
          onChange={event => setMatchById(event.target.checked)} />
        数组按 id 匹配
      </label>
    </form>
    <p className="response-diff-hint" id={hintId}>逗号分隔；字段名忽略任意层级，$ 开头的完整路径忽略该位置及子树。</p>
    <p className="response-diff-hint" id={matchingId}>仅在两侧数组的所有项均为具有唯一 string / number id 的对象时按 id 匹配，否则按下标比较。</p>
    {matchById && <p className="response-diff-hint">按 id 匹配时路径使用当前响应下标；删除项使用基准下标。</p>}
    <p className="response-diff-count" role="status">
      {result.truncated ? `已列出 ${result.changes.length} 项差异（部分结果）`
        : result.changes.length ? `共 ${result.changes.length} 项差异` : '未发现差异（已应用当前忽略规则）'}
    </p>
    {result.truncated && <p className="response-diff-warning" role="alert">达到比较上限（最多 {MAX_CHANGES} 项差异 / {MAX_NODES} 个检查节点，含 id 校验）；比较未完成，不能判定两份 JSON 完全一致。</p>}
    {changes.length > 0 && <ol className="response-diff-list" aria-label="JSON 差异" start={page * PAGE_SIZE + 1}>
      {changes.map((change, index) => <li
        key={`${page}:${index}:${change.kind}:${change.path}`}
        className={`response-diff-change response-diff-${change.kind}`}
      >
        <div className="response-diff-change-heading">
          <span className="response-diff-kind">{KIND_LABELS[change.kind]}</span>
          <code>{change.path}</code>
        </div>
        <dl className="response-diff-values">
          {change.kind !== 'added' && <ValuePreview value={change.before} label="基准值" path={change.path} />}
          {change.kind !== 'removed' && <ValuePreview value={change.after} label="当前值" path={change.path} />}
        </dl>
      </li>)}
    </ol>}
    {pages > 1 && <nav className="response-diff-pagination" aria-label="差异分页">
      <button type="button" aria-label="上一页差异" disabled={page === 0}
        onClick={() => setPagination({ result, page: page - 1 })}>上一页</button>
      <span>第 {page + 1} / {pages} 页</span>
      <button type="button" aria-label="下一页差异" disabled={page >= pages - 1}
        onClick={() => setPagination({ result, page: page + 1 })}>下一页</button>
      <span className="response-diff-hint">每页 {PAGE_SIZE} 项</span>
    </nav>}
  </section>;
}
