import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';

export function RequestTabs({ model }: { model: Workbench }) {
  const [menu, setMenu] = useState<{ type: 'tab' | 'all'; id?: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requests = model.openTabs.flatMap(id => {
    const request = model.workspace.requests.find(r => r.id === id && model.workspace.services.some(s => s.id === r.serviceId && s.projectId === model.project?.id));
    return request ? [request] : [];
  });
  const requestById = (id: string) => requests.find(request => request.id === id);
  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    const onResize = () => closeMenu();
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [menu]);

  const openTabMenu = (event: MouseEvent, id: string) => {
    event.preventDefault();
    setMenu({ type: 'tab', id, x: event.clientX, y: event.clientY });
  };
  const closeOthers = (id: string) => {
    model.closeTabs(requests.filter(request => request.id !== id).map(request => request.id));
    closeMenu();
  };
  const closeToRight = (id: string) => {
    const index = requests.findIndex(request => request.id === id);
    model.closeTabs(requests.slice(index + 1).map(request => request.id));
    closeMenu();
  };
  const closeCurrent = (id: string) => {
    model.closeTabs([id]);
    closeMenu();
  };
  const selectFromAll = (id: string) => {
    model.selectRequest(id);
    closeMenu();
  };

  return <div className="request-tabs" aria-label="已打开接口">
    <div role="tablist" aria-label="接口标签">
      {requests.map((r, index) => <div className={`request-tab ${r.id === model.selectedId ? 'active' : ''}`} key={r.id}>
        <button role="tab" aria-selected={r.id === model.selectedId} disabled={model.busy} aria-label={`切换到 ${r.name}`} onClick={() => model.selectRequest(r.id)} onContextMenu={event => openTabMenu(event, r.id)} onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? requests.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + requests.length) % requests.length;
          const buttons = e.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLButtonElement>('[role=tab]');
          buttons?.[next].focus();
          model.selectRequest(requests[next].id);
        }}><span className={`method method-${r.method}`}>{r.method}</span><span className="ellipsis">{r.name}</span></button>
        <button disabled={model.busy} className="tab-close" aria-label={`关闭标签 ${r.name}`} title="关闭标签不删除接口、草稿或响应" onClick={() => closeCurrent(r.id)} onContextMenu={event => openTabMenu(event, r.id)}><X size={13} aria-hidden="true" /></button>
      </div>)}
    </div>
    {!requests.length && <span className="hint">从左侧打开接口</span>}
    <div className="request-tab-actions">
      <small>关闭标签保留草稿与响应</small>
      <button className="text-button restore-tab-button" aria-label="恢复最近关闭标签" title="恢复最近关闭标签 · Ctrl/Cmd+Shift+T" disabled={model.busy || model.loading || !model.canRestoreClosedTab} onClick={() => void model.restoreClosedTab()}>恢复</button>
      <div className="all-tabs-menu">
        <button className="all-tabs-trigger" aria-label="全部标签" aria-expanded={menu?.type === 'all'} disabled={model.busy || model.loading || !requests.length} onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu(menu?.type === 'all' ? null : { type: 'all', x: rect.right, y: rect.bottom + 4 });
        }}><span>全部标签</span><ChevronDown size={13} aria-hidden="true" /></button>
      </div>
      <button className="close-all-tabs" aria-label="关闭全部标签" title="关闭当前项目的全部标签，保留接口、草稿与响应" disabled={model.busy || model.loading || !requests.length} onClick={() => void model.closeAllTabs()}>关闭全部</button>
    </div>
    {menu && <div ref={menuRef} className="request-tabs-menu" role="menu" aria-label={menu.type === 'all' ? '全部标签' : '标签管理'} style={{ left: menu.x, top: menu.y }}>
      {menu.type === 'all'
        ? requests.map(request => <button role="menuitem" aria-label={`切换到 ${request.name}`} key={request.id} onClick={() => selectFromAll(request.id)}><span className={`method method-${request.method}`}>{request.method}</span><span className="ellipsis">切换到 {request.name}</span></button>)
        : (() => {
          const current = requestById(menu.id!);
          if (!current) return null;
          return <>
            <button role="menuitem" onClick={() => closeCurrent(current.id)}>关闭当前标签</button>
            <button role="menuitem" disabled={requests.length < 2} onClick={() => closeOthers(current.id)}>关闭其他标签</button>
            <button role="menuitem" disabled={!requests.some((request, index) => index > requests.findIndex(item => item.id === current.id))} onClick={() => closeToRight(current.id)}>关闭右侧标签</button>
          </>;
        })()}
    </div>}
  </div>;
}
