import { Plus, Trash2 } from 'lucide-react';
import type { Pair } from '../types';
import { uid } from '../lib/workspace';

export function PairsEditor({ value, onChange, label = '参数' }: { value: Pair[]; onChange: (value: Pair[]) => void; label?: string }) {
  const update = (id: string, patch: Partial<Pair>) => onChange(value.map(p => p.id === id ? { ...p, ...patch } : p));
  return <div className="pairs">
    <div className="pair-row table-heading"><span>启用</span><span>名称</span><span>值</span><span /></div>
    {value.map((p, i) => <div className="pair-row" key={p.id}>
      <input type="checkbox" aria-label={`启用${label}${i + 1}`} checked={p.enabled} onChange={e => update(p.id, { enabled: e.target.checked })} />
      <input aria-label={`${label}名称${i + 1}`} placeholder="名称" value={p.key} onChange={e => update(p.id, { key: e.target.value })} />
      <input aria-label={`${label}值${i + 1}`} placeholder="值或 {{变量}}" value={p.value} onChange={e => update(p.id, { value: e.target.value })} />
      <button className="icon-button" aria-label={`删除${label}${i + 1}`} onClick={() => onChange(value.filter(x => x.id !== p.id))}><Trash2 size={14} /></button>
    </div>)}
    {!value.length && <div className="table-empty">还没有{label}，添加一项开始配置。</div>}
    <button className="text-button" onClick={() => onChange([...value, { id: uid(), key: '', value: '', enabled: true }])}><Plus size={14} />添加{label}</button>
  </div>;
}
