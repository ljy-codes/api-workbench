import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';
import { arrayColumns, arrayPaths, cellValue, formatJsonPath, jsonPreview, resolveJsonPath, type JsonPath } from '../lib/json-inspection';
import './json-inspection.css';

const pageSize = 50;
const noRows: unknown[] = [];
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return (typeof a === 'string' ? a : jsonPreview(a))
    .localeCompare(typeof b === 'string' ? b : jsonPreview(b), undefined, { numeric: true });
}
function detailText(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 12_000 ? text.slice(0, 12_000) + '\n…（详情预览仅显示前 12000 字符，请在 JSON 中定位查看完整内容）' : text;
  } catch { return '嵌套过深，请在 JSON 中定位查看。'; }
}

export function JsonArrayTable({ value, onLocate }: { value: unknown; onLocate?: (path: JsonPath) => void }) {
  const discovered = useMemo(() => arrayPaths(value), [value]);
  const [selected, setSelected] = useState('');
  const selectedPath = discovered.paths.find(path => formatJsonPath(path) === selected) ?? discovered.paths[0];
  const result = selectedPath ? resolveJsonPath(value, selectedPath) : { found: false as const };
  const rows = result.found && Array.isArray(result.value) ? result.value as unknown[] : noRows;
  const columns = useMemo(() => arrayColumns(rows), [rows]);
  const [visible, setVisible] = useState<string[] | null>(null);
  const keys = (visible ?? columns.keys.slice(0, 12)).filter(key => columns.keys.includes(key));
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [filterColumn, setFilterColumn] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: number } | null>(null);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ value: unknown; path: JsonPath } | null>(null);
  const filtered = useMemo(() => {
    const query = deferredFilter.toLocaleLowerCase();
    const searching = filterColumn ? [filterColumn] : columns.keys;
    const indexes = rows.map((_, index) => index).filter(index => !query || searching.some(key => {
      const cell = cellValue(rows[index], key, columns.scalar);
      return cell.found && (typeof cell.value === 'string' ? cell.value : jsonPreview(cell.value))
        .toLocaleLowerCase().includes(query);
    }));
    if (sort) indexes.sort((a, b) => {
      const av = cellValue(rows[a], sort.key, columns.scalar);
      const bv = cellValue(rows[b], sort.key, columns.scalar);
      return sort.direction * compare(av.found ? av.value : undefined, bv.found ? bv.value : undefined) || a - b;
    });
    return indexes;
  }, [rows, deferredFilter, filterColumn, columns, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const switchArray = (path: string) => {
    setSelected(path); setVisible(null); setSort(null); setFilter(''); setFilterColumn(''); setPage(0); setDetail(null);
  };
  if (!selectedPath) return <div className="table-empty">此响应没有可展示的数组</div>;
  return <div className="json-array-view">
    <div className="json-array-controls">
      <select aria-label="选择 JSON 数组" value={formatJsonPath(selectedPath)} onChange={event => switchArray(event.target.value)}>
        {discovered.paths.map(path => <option key={formatJsonPath(path)} value={formatJsonPath(path)}>{formatJsonPath(path)}</option>)}
      </select>
      <span className="muted">{rows.length} 行 · {columns.keys.length} 列</span>
      <details className="json-column-picker"><summary><Columns3 size={13} />选择列</summary><div>
        {columns.keys.map(key => <label key={key}><input type="checkbox" aria-label={`显示列 ${key}`} checked={keys.includes(key)} onChange={event => setVisible(event.target.checked ? [...keys, key] : keys.filter(item => item !== key))} />{key || '（空字段名）'}</label>)}
        {!columns.keys.length && <span>没有字段</span>}
      </div></details>
    </div>
    <div className="json-array-filter">
      <select aria-label="筛选列" value={filterColumn} onChange={event => { setFilterColumn(event.target.value); setPage(0); }}>
        <option value="">全部列</option>{columns.keys.filter(Boolean).map(key => <option key={key} value={key}>{key}</option>)}
      </select>
      <input aria-label="筛选数组行" type="search" placeholder="筛选字段值" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} />
      <span className="muted">匹配 {filtered.length} 行</span>
    </div>
    {(discovered.truncated || columns.truncated) && <p className="warning-line">数组发现最多检查 20000 个节点、100 个数组，列最多展示 100 个；部分结构未列出，可通过 JSON 字段定位查看。</p>}
    {rows.length === 0 ? <div className="table-empty">数组为空</div> : <div className="json-array-scroll">
      <table className="json-array-table" aria-label="JSON 数组数据">
        <thead><tr><th scope="col">下标</th>{keys.map(key => <th scope="col" key={key} aria-sort={sort?.key === key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}>
          <button aria-label={`按 ${key} 排序`} onClick={() => { setSort({ key, direction: sort?.key === key ? -sort.direction : 1 }); setPage(0); }}>{key || '（空字段名）'}{sort?.key === key && (sort.direction === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button>
        </th>)}</tr></thead>
        <tbody>{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(index => <tr key={index}>
          <th scope="row">{index}</th>{keys.map(key => {
            const cell = cellValue(rows[index], key, columns.scalar);
            const item = cell.found ? cell.value : undefined;
            const type = item === null ? 'literal' : typeof item === 'object' ? 'container' : typeof item === 'boolean' ? 'literal' : typeof item;
            const path = [...selectedPath, index, ...(columns.scalar ? [] : [key])];
            return <td key={key} className={`json-cell json-cell-${type}`}>{item !== null && typeof item === 'object'
              ? <button className="json-cell-detail" aria-label={`查看嵌套值 ${formatJsonPath(path)}`} onClick={() => setDetail({ value: item, path })}>{jsonPreview(item)}</button>
              : <span title={typeof item === 'string' ? item : undefined}>{jsonPreview(item)}</span>}</td>;
          })}</tr>)}</tbody>
      </table>
      {!filtered.length && <div className="table-empty">没有匹配的行</div>}
    </div>}
    {detail && <div className="json-cell-preview"><div><code>{formatJsonPath(detail.path)}</code>
      {onLocate && <button onClick={() => onLocate(detail.path)}>在 JSON 中定位</button>}
      <button onClick={() => setDetail(null)}>关闭详情</button></div>
      <pre aria-label="数组单元格详情">{detailText(detail.value)}</pre>
    </div>}
    <div className="json-pagination"><span>第 {currentPage + 1} / {pages} 页 · 每页 {pageSize} 行</span>
      <button aria-label="上一页数组" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <button aria-label="下一页数组" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div>
  </div>;
}
