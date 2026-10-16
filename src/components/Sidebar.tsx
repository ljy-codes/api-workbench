import { ChevronDown, FolderClosed, FolderPlus, ListCollapse, Plus, Search, Server, Waypoints } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { RequestDefinition, Workspace } from '../types';

type CreateTarget = { kind: 'folder' | 'request'; serviceId: string; parentId: string | null };
type TreeMenu = { projectId: string | null; serviceId: string; parentId: string | null; x: number; y: number };

export function Sidebar({ workspace: w, selectedId, onSelect, onManage, onCreate, disabled = false }: { workspace: Workspace; selectedId: string | null; onSelect: (id: string) => void; onManage: () => void; onCreate?: (target: CreateTarget) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [context, setContext] = useState<TreeMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const toggle = (id: string) => setCollapsed(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const project = w.projects.find(p => p.id === w.activeProjectId);
  const term = search.trim().toLocaleLowerCase();
  const services = w.services.filter(s => s.projectId === w.activeProjectId);
  const menu = !disabled && onCreate && context?.projectId === w.activeProjectId
    && services.some(s => s.id === context.serviceId)
    && (!context.parentId || w.folders.some(f => f.id === context.parentId && f.serviceId === context.serviceId)) ? context : null;
  useEffect(() => { setContext(null); }, [w.activeProjectId, disabled]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true });
    const dismiss = () => setContext(null);
    const pointerDown = (event: PointerEvent) => { if (!element.contains(event.target as Node)) dismiss(); };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); triggerRef.current?.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') dismiss();
    };
    document.addEventListener('pointerdown', pointerDown);
    document.addEventListener('keydown', keyDown);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('keydown', keyDown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [menu]);
  const openMenu = (button: HTMLButtonElement, serviceId: string, parentId: string | null, x?: number, y?: number) => {
    if (disabled || !onCreate) return;
    triggerRef.current = button;
    const rect = button.getBoundingClientRect();
    setContext({ projectId: w.activeProjectId, serviceId, parentId, x: x || rect.left, y: y || rect.bottom });
  };
  const contextHandlers = (serviceId: string, parentId: string | null) => ({
    onContextMenu: (event: MouseEvent<HTMLButtonElement>) => {
      if (!onCreate) return;
      event.preventDefault();
      openMenu(event.currentTarget, serviceId, parentId, event.clientX, event.clientY);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (onCreate && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        openMenu(event.currentTarget, serviceId, parentId);
      }
    },
  });
  const collapseAll = () => {
    setSearch('');
    setContext(null);
    setCollapsed(prev => new Set([...prev, ...services.map(s => s.id), ...w.folders.filter(f => services.some(s => s.id === f.serviceId)).map(f => f.id)]));
  };
  const create = (kind: CreateTarget['kind']) => {
    if (!menu) return;
    const ancestors = new Set([menu.serviceId]);
    let parentId = menu.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = w.folders.find(f => f.id === parentId && f.serviceId === menu.serviceId)?.parentId ?? null;
    }
    setCollapsed(prev => new Set([...prev].filter(id => !ancestors.has(id))));
    setSearch('');
    setContext(null);
    onCreate?.({ kind, serviceId: menu.serviceId, parentId: menu.parentId });
  };
  const matches = w.requests.filter(r => services.some(s => s.id === r.serviceId)).filter(r => [r.name, r.path, r.method, w.services.find(s => s.id === r.serviceId)?.name].join(' ').toLocaleLowerCase().includes(term));
  const requestNode = (r: RequestDefinition) => <button key={r.id} className={`request-node ${selectedId === r.id ? 'selected' : ''}`} title={`${r.name}\n${r.method} ${r.path}`} disabled={disabled} onClick={() => onSelect(r.id)} {...contextHandlers(r.serviceId, r.folderId)}><span className={`method method-${r.method}`}>{r.method}</span><span className="ellipsis">{r.name}</span></button>;
  const requests = (serviceId: string, folderId: string | null) => matches.filter(r => r.serviceId === serviceId && r.folderId === folderId).map(requestNode);
  const folders = (serviceId: string, parentId: string | null, seen = new Set<string>()) => w.folders.filter(f => f.serviceId === serviceId && f.parentId === parentId && !seen.has(f.id)).map(f =>
    <div className="folder-group" key={f.id}>
      <button className="folder-node" title={f.name} onClick={() => toggle(f.id)} aria-expanded={!collapsed.has(f.id)} {...contextHandlers(serviceId, f.id)}><ChevronDown size={12} className={collapsed.has(f.id) ? 'collapsed' : ''} /><FolderClosed size={14} /><span className="ellipsis">{f.name}</span></button>
      {(!collapsed.has(f.id) || term) && <div className="folder-children">{requests(serviceId, f.id)}{folders(serviceId, f.id, new Set([...seen, f.id]))}</div>}
    </div>);
  return <aside className="sidebar">
    <div className="sidebar-title"><span>接口集合 <small>{services.reduce((n, s) => n + w.requests.filter(r => r.serviceId === s.id).length, 0)}</small></span><div className="sidebar-actions"><button className="icon-button" aria-label="一键收起" title="收起全部服务和目录，并清除搜索" disabled={disabled || !services.length} onClick={collapseAll}><ListCollapse size={16} /></button><button className="icon-button" aria-label="管理接口集合" disabled={disabled} onClick={onManage}><Plus size={17} /></button></div></div>
    <label className="search-field"><Search size={15} /><input aria-label="搜索接口" value={search} disabled={disabled} onChange={e => setSearch(e.target.value)} placeholder="名称 / 路径 / 方法 / 服务" /><kbd>/</kbd></label>
    <div className="service-tree">
      {services.filter(s => !term || matches.some(r => r.serviceId === s.id)).map(s => <section key={s.id} className="service-group">
        <button className="service-node" title={`${s.name}\n${w.bindings.find(b => b.serviceId === s.id && b.environmentId === project?.activeEnvironmentId)?.baseUrl || '当前环境未配置地址'}`} onClick={() => toggle(s.id)} aria-expanded={!collapsed.has(s.id)} {...contextHandlers(s.id, null)}><ChevronDown size={13} className={collapsed.has(s.id) ? 'collapsed' : ''} /><Server size={15} /><span className="ellipsis">{s.name}</span><small>{w.requests.filter(r => r.serviceId === s.id).length}</small></button>
        {(!collapsed.has(s.id) || term) && (term ? matches.filter(r => r.serviceId === s.id).map(requestNode) : <>{requests(s.id, null)}{folders(s.id, null)}</>)}
      </section>)}
      {!services.length && <div className="sidebar-empty"><Server size={24} /><p>从第一个服务开始</p><button className="text-button" disabled={disabled} onClick={onManage}>创建项目与服务 →</button></div>}
      {term && !matches.some(r => services.some(s => s.id === r.serviceId)) && <p className="muted padded">没有匹配的接口</p>}
    </div>
    <div className="sidebar-bottom"><span className="status-dot" />本地工作区<span className="mono">rev {w.revision}</span></div>
    {menu && createPortal(<div ref={menuRef} className="tree-context-menu" role="menu" aria-label="添加目录或接口" style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}><button role="menuitem" onClick={() => create('folder')}><FolderPlus size={15} />添加目录</button><button role="menuitem" onClick={() => create('request')}><Waypoints size={15} />添加接口</button></div>, document.body)}
  </aside>;
}
