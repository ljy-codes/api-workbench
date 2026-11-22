import { forwardRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';

export const JsonToolsSearch = forwardRef<HTMLInputElement, {
  query: string; count: number; capped: boolean; active: number;
  onChange: (query: string) => void; onMove: (direction: 1 | -1) => void;
}>(function JsonToolsSearch({ query, count, capped, active, onChange, onMove }, ref) {
  return <div className="json-tools-search" role="search" aria-label="JSON 内容搜索">
    <Search size={15} aria-hidden="true" />
    <input ref={ref} type="search" aria-label="搜索 JSON" placeholder="搜索字段或值 · Ctrl/Cmd+F"
      value={query} onChange={event => onChange(event.target.value)} spellCheck={false}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault(); onMove(event.shiftKey ? -1 : 1);
        }
      }} />
    <span className="json-tools-match-count" role="status" aria-label="搜索结果">
      {!query ? '普通文本 · 忽略大小写' : !count ? '无匹配' : `${active >= 0 ? active + 1 : '—'} / ${count}${capped ? '+' : ''}`}
    </span>
    <button type="button" className="icon-button" aria-label="上一个匹配" title="上一个 · Shift+Enter" disabled={!count} onClick={() => onMove(-1)}><ChevronUp size={16} /></button>
    <button type="button" className="icon-button" aria-label="下一个匹配" title="下一个 · Enter" disabled={!count} onClick={() => onMove(1)}><ChevronDown size={16} /></button>
    <button type="button" className="icon-button" aria-label="清除搜索" title="清除搜索" disabled={!query} onClick={() => onChange('')}><X size={15} /></button>
  </div>;
});
