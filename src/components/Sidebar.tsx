import { ChevronDown, FolderClosed, Plus, Search, Server } from 'lucide-react';
import { useState } from 'react';
import type { Workspace } from '../types';

export function Sidebar({ workspace: w, selectedId, onSelect, onManage, disabled = false }: { workspace: Workspace; selectedId: string | null; onSelect: (id: string) => void; onManage: () => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const project = w.projects.find(p => p.id === w.activeProjectId);
  const term = search.trim().toLocaleLowerCase();
  const services = w.services.filter(s => s.projectId === w.activeProjectId);
  const matches = w.requests.filter(r => services.some(s => s.id === r.serviceId)).filter(r => [r.name, r.path, r.method, w.services.find(s => s.id === r.serviceId)?.name].join(' ').toLocaleLowerCase().includes(term));
  const requests = (serviceId: string, folderId: string | null) => matches.filter(r => r.serviceId === serviceId && r.folderId === folderId).map(r =>
    <button key={r.id} className={`request-node ${selectedId === r.id ? 'selected' : ''}`} disabled={disabled} onClick={() => onSelect(r.id)}><span className={`method method-${r.method}`}>{r.method}</span><span className="ellipsis">{r.name}</span></button>);
  const folders = (serviceId: string, parentId: string | null, seen = new Set<string>()) => w.folders.filter(f => f.serviceId === serviceId && f.parentId === parentId && !seen.has(f.id)).map(f =>
    <div className="folder-group" key={f.id}>
      <button className="folder-node" onClick={() => toggle(f.id)} aria-expanded={!collapsed.has(f.id)}><ChevronDown size={12} className={collapsed.has(f.id) ? 'collapsed' : ''} /><FolderClosed size={14} />{f.name}</button>
      {(!collapsed.has(f.id) || term) && <div className="folder-children">{requests(serviceId, f.id)}{folders(serviceId, f.id, new Set([...seen, f.id]))}</div>}
    </div>);
  return <aside className="sidebar">
    <div className="sidebar-title"><span>接口集合 <small>{services.reduce((n, s) => n + w.requests.filter(r => r.serviceId === s.id).length, 0)}</small></span><button className="icon-button" aria-label="管理接口集合" disabled={disabled} onClick={onManage}><Plus size={17} /></button></div>
    <label className="search-field"><Search size={15} /><input aria-label="搜索接口" value={search} disabled={disabled} onChange={e => setSearch(e.target.value)} placeholder="名称 / 路径 / 方法 / 服务" /><kbd>/</kbd></label>
    <div className="service-tree">
      {services.filter(s => !term || matches.some(r => r.serviceId === s.id)).map(s => <section key={s.id} className="service-group">
        <button className="service-node" onClick={() => toggle(s.id)} aria-expanded={!collapsed.has(s.id)}><ChevronDown size={13} className={collapsed.has(s.id) ? 'collapsed' : ''} /><Server size={15} /><span>{s.name}</span><small>{w.requests.filter(r => r.serviceId === s.id).length}</small></button>
        <div className="service-base ellipsis" title={w.bindings.find(b => b.serviceId === s.id && b.environmentId === project?.activeEnvironmentId)?.baseUrl}>{w.bindings.find(b => b.serviceId === s.id && b.environmentId === project?.activeEnvironmentId)?.baseUrl || '当前环境未配置地址'}</div>
        {(!collapsed.has(s.id) || term) && (term ? matches.filter(r => r.serviceId === s.id).map(r => <button key={r.id} className={`request-node ${selectedId === r.id ? 'selected' : ''}`} disabled={disabled} onClick={() => onSelect(r.id)}><span className={`method method-${r.method}`}>{r.method}</span><span className="ellipsis">{r.name}</span></button>) : <>{requests(s.id, null)}{folders(s.id, null)}</>)}
      </section>)}
      {!services.length && <div className="sidebar-empty"><Server size={24} /><p>从第一个服务开始</p><button className="text-button" disabled={disabled} onClick={onManage}>创建项目与服务 →</button></div>}
      {term && !matches.some(r => services.some(s => s.id === r.serviceId)) && <p className="muted padded">没有匹配的接口</p>}
    </div>
    <div className="sidebar-bottom"><span className="status-dot" />本地工作区<span className="mono">rev {w.revision}</span></div>
  </aside>;
}
