import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LayoutGrid, Plus, Trash2 } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { uid } from '../lib/workspace';
import { unifyServiceAddresses } from '../lib/service-addresses';

function moveProjectItem<T extends { id: string; projectId: string }>(items: T[], projectId: string, id: string, step: -1 | 1): T[] {
  const siblings = items.filter(item => item.projectId === projectId);
  const index = siblings.findIndex(item => item.id === id);
  const target = siblings[index + step];
  if (index < 0 || !target) return items;
  const source = siblings[index];
  return items.map(item => item === source ? target : item === target ? source : item);
}

export function EnvironmentMatrix({ model, onManage }: { model: Workbench; onManage: () => void }) {
  const { workspace: w, project, mutate } = model;
  const services = w.services.filter(s => s.projectId === project?.id);
  const environments = w.environments.filter(e => e.projectId === project?.id);
  const disabled = model.busy || model.loading;
  const move = (kind: 'services' | 'environments', id: string, step: -1 | 1) => {
    if (disabled || !project) return;
    mutate(ws => {
      if (ws.activeProjectId !== project.id) return ws;
      return kind === 'services'
        ? { ...ws, services: moveProjectItem(ws.services, project.id, id, step) }
        : { ...ws, environments: moveProjectItem(ws.environments, project.id, id, step) };
    });
  };
  return <section className="page-panel">
    <div className="page-heading"><div><div className="eyebrow">ENVIRONMENTS</div><h1>一份接口，连接不同环境</h1><p>按服务配置基础地址。切换环境不改变已经发出的请求。</p></div><button onClick={onManage}><Plus size={15} />管理环境与服务</button></div>
    {(!services.length || !environments.length) ? <div className="empty-state"><LayoutGrid size={36} /><h2>还缺少服务或环境</h2><p>先创建项目、环境与服务，再配置它们之间的地址绑定。</p><button className="primary" onClick={onManage}>开始配置</button></div> : <>
      <p className="matrix-hint">服务名固定在左侧。用 ↑ ↓ 调整服务顺序，用 ← → 调整环境顺序；调整后保存即可保留。</p>
      <div className="matrix-scroll" role="region" aria-label="服务环境地址矩阵，可横向滚动" tabIndex={0}>
        <table className="matrix" aria-label="服务环境地址矩阵">
          <thead><tr>
            <th scope="col" className="matrix-service-column">服务 / 环境</th>
            {environments.map((e, index) => <th scope="col" key={e.id}>
              <div className="matrix-heading">
                <span className="matrix-environment-name" title={e.name}><span className={`status-dot ${e.isProduction ? 'production' : ''}`} />{e.name}{e.isProduction && <span className="production-tag">生产</span>}</span>
                <span className="matrix-order-actions">
                  <button type="button" className="icon-button" aria-label={`左移环境 ${e.name}`} title="左移环境" disabled={disabled || index === 0} onClick={() => move('environments', e.id, -1)}><ArrowLeft size={14} /></button>
                  <button type="button" className="icon-button" aria-label={`右移环境 ${e.name}`} title="右移环境" disabled={disabled || index === environments.length - 1} onClick={() => move('environments', e.id, 1)}><ArrowRight size={14} /></button>
                </span>
              </div>
            </th>)}
          </tr></thead>
          <tbody>{services.map((s, index) => <tr key={s.id}>
            <th scope="row" className="matrix-service-column">
              <div className="matrix-heading">
                <span className="matrix-service-name" title={s.name}>{s.name}</span>
                <span className="matrix-order-actions">
                  <button type="button" className="icon-button" aria-label={`上移服务 ${s.name}`} title="上移服务" disabled={disabled || index === 0} onClick={() => move('services', s.id, -1)}><ArrowUp size={14} /></button>
                  <button type="button" className="icon-button" aria-label={`下移服务 ${s.name}`} title="下移服务" disabled={disabled || index === services.length - 1} onClick={() => move('services', s.id, 1)}><ArrowDown size={14} /></button>
                </span>
              </div>
            </th>
            {environments.map(e => {
              const b = w.bindings.find(b => b.serviceId === s.id && b.environmentId === e.id);
              const patch = (changes: { baseUrl?: string; enabled?: boolean }) => mutate(ws => {
                const unified = unifyServiceAddresses(ws);
                return { ...unified, bindings: b ? unified.bindings.map(x => x.id === b.id ? { ...x, ...changes } : x) : [...unified.bindings, { id: uid(), projectId: project!.id, serviceId: s.id, environmentId: e.id, baseUrl: '', enabled: true, ...changes }] };
              });
              return <td key={e.id}><input aria-label={`${s.name} ${e.name} 基础地址`} value={b?.baseUrl ?? ''} placeholder="https://api.example.com/v1" onChange={event => patch({ baseUrl: event.target.value })} /><div className="matrix-controls"><label className="checkbox-label"><input type="checkbox" checked={b?.enabled ?? false} onChange={event => patch({ enabled: event.target.checked })} />启用绑定</label>{b && <button className="icon-button" aria-label={`移除 ${s.name} ${e.name} 绑定`} onClick={async () => { if (await model.confirm({ title: '移除环境绑定？', message: '将同时删除此绑定层变量。该服务在此环境将无法发送请求。', danger: true, confirmLabel: '移除绑定' })) mutate(ws => ({ ...ws, bindings: ws.bindings.filter(x => x.id !== b.id), variables: ws.variables.filter(v => !(v.scope === 'binding' && v.ownerId === b.id)) })); }}><Trash2 size={14} /></button>}</div></td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    <div className="info-card"><LayoutGrid size={19} /><div><strong>环境地址与接口路径分开维护</strong><p>基础地址可包含网关前缀。接口编辑区只需填写相对路径；最终地址由桌面端解析并脱敏预览。</p></div></div>
  </section>;
}
