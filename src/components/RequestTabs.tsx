import type { Workbench } from '../hooks/useWorkbench';

export function RequestTabs({ model }: { model: Workbench }) {
  const requests = model.openTabs.flatMap(id => {
    const request = model.workspace.requests.find(r => r.id === id && model.workspace.services.some(s => s.id === r.serviceId && s.projectId === model.project?.id));
    return request ? [request] : [];
  });
  return <div className="request-tabs" aria-label="已打开接口">
    <div role="tablist" aria-label="接口标签">{requests.map((r, index) => <div className={`request-tab ${r.id === model.selectedId ? 'active' : ''}`} key={r.id}>
      <button role="tab" aria-selected={r.id === model.selectedId} disabled={model.busy} aria-label={`切换到 ${r.name}`} onClick={() => model.selectRequest(r.id)} onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? requests.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + requests.length) % requests.length;
        const buttons = e.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLButtonElement>('[role=tab]');
        buttons?.[next].focus();
        model.selectRequest(requests[next].id);
      }}><span className={`method method-${r.method}`}>{r.method}</span><span className="ellipsis">{r.name}</span></button>
      <button disabled={model.busy} className="tab-close" aria-label={`关闭标签 ${r.name}`} title="关闭标签不删除接口、草稿或响应" onClick={() => model.closeTab(r.id)}>×</button>
    </div>)}</div>
    {!requests.length && <span className="hint">从左侧打开接口</span>}
    <small>关闭标签保留草稿与响应</small>
  </div>;
}
