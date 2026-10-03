import { useState } from 'react';
import { Eye, EyeOff, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { VariableScope } from '../types';
import { uid, variableOwners } from '../lib/workspace';
import { PairsEditor } from './PairsEditor';

export function VariablesEditor({ model }: { model: Workbench }) {
  const { workspace: w, project, environment, request, mutate } = model;
  const [scope, setScope] = useState<VariableScope | 'temporary'>('request');
  const [revealed, setRevealed] = useState(new Set<string>());
  const owners = variableOwners(w, project?.id ?? '', environment?.id ?? null, request);
  const owner = owners.find(o => o.scope === scope);
  const vars = w.variables.filter(v => v.scope === scope && v.ownerId === owner?.ownerId);
  const update = (id: string, patch: Partial<typeof vars[number]>) => mutate(ws => ({ ...ws, variables: ws.variables.map(v => v.id === id ? { ...v, ...patch } : v) }));
  return <section className="variables-editor">
    <div className="section-toolbar"><div><h3>变量与覆盖</h3><p>从左到右优先级递增，同名变量由后层覆盖。</p></div><ShieldCheck size={20} className="cyan" /></div>
    <div className="scope-tabs" role="tablist" aria-label="变量作用域">
      {owners.map((o, i) => <button role="tab" aria-selected={scope === o.scope} key={o.scope} onClick={() => { setScope(o.scope); setRevealed(new Set()); }}><small>{i + 1}</small>{o.label}</button>)}
      <button role="tab" aria-selected={scope === 'temporary'} onClick={() => setScope('temporary')}><small>6</small>本次临时</button>
    </div>
    <p className="hint">路径中的 <code>{'{{变量名}}'}</code> 也从以上作用域读取。临时变量不落盘；持久秘密值保存后不回传，留空表示保留原值。</p>
    {scope === 'temporary' ? request ? <PairsEditor value={model.temporary} onChange={model.setTemporary} label="临时变量" /> : <div className="table-empty">请先选择一个接口。</div> : !owner?.ownerId ? <div className="table-empty">请先选择对应的项目、环境或接口；绑定变量需要先在环境矩阵中配置地址。</div> : <>
      <div className="variable-row table-heading"><span>变量名</span><span>变量值</span><span>秘密值</span><span /></div>
      {vars.map(v => <div className="variable-row" key={v.id}>
        <input aria-label="变量名" value={v.name} placeholder="如 userId" onChange={e => update(v.id, { name: e.target.value })} />
        <div className="secret-field"><input autoComplete="off" type={v.isSecret && !revealed.has(v.id) ? 'password' : 'text'} aria-label={`${v.name || '新变量'}的值`} value={v.value} placeholder={v.isSecret ? '已存秘密不回传 · 留空保留' : '输入变量值'} onChange={e => update(v.id, { value: e.target.value })} />{v.isSecret && <button className="icon-button" aria-label={revealed.has(v.id) ? '隐藏秘密值' : '显示本次输入值'} onClick={() => setRevealed(prev => { const n = new Set(prev); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; })}>{revealed.has(v.id) ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>
        <label className="checkbox-label"><input type="checkbox" checked={v.isSecret} onChange={e => update(v.id, { isSecret: e.target.checked })} />秘密</label>
        <button className="icon-button" aria-label={`删除变量 ${v.name}`} onClick={() => mutate(ws => ({ ...ws, variables: ws.variables.filter(x => x.id !== v.id) }))}><Trash2 size={14} /></button>
      </div>)}
      {!vars.length && <div className="table-empty">此层还没有变量，其他层的变量仍可继承。</div>}
      <button className="text-button" onClick={() => mutate(ws => ({ ...ws, variables: [...ws.variables, { id: uid(), projectId: project!.id, ownerId: owner.ownerId, scope: scope as VariableScope, name: '', value: '', isSecret: false }] }))}><Plus size={14} />添加变量</button>
    </>}
    {model.preview && <div className="resolved-variables"><h4>原生解析结果 · 已脱敏</h4>{model.preview.resolvedVariables.length ? model.preview.resolvedVariables.map(v => <div key={v.name}><code>{v.name}</code><code>{v.isSecret ? '••••••' : v.value}</code><span className="badge">{v.source}</span></div>) : <p className="muted">没有使用变量</p>}</div>}
  </section>;
}
