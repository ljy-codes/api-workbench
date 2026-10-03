import { Globe2, Plus, Trash2 } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { uid } from '../lib/workspace';

export function EnvironmentMatrix({ model, onManage }: { model: Workbench; onManage: () => void }) {
  const { workspace: w, project, mutate } = model;
  const services = w.services.filter(s => s.projectId === project?.id);
  const environments = w.environments.filter(e => e.projectId === project?.id);
  return <section className="page-panel">
    <div className="page-heading"><div><div className="eyebrow">ENVIRONMENTS</div><h1>一份接口，连接不同环境</h1><p>按服务配置基础地址。切换环境不改变已经发出的请求。</p></div><button onClick={onManage}><Plus size={15} />管理环境与服务</button></div>
    {(!services.length || !environments.length) ? <div className="empty-state"><Globe2 size={36} /><h2>还缺少服务或环境</h2><p>先创建项目、环境与服务，再配置它们之间的地址绑定。</p><button className="primary" onClick={onManage}>开始配置</button></div> : <div className="matrix-scroll"><table className="matrix"><thead><tr><th>服务 / 环境</th>{environments.map(e => <th key={e.id}><span className={`status-dot ${e.isProduction ? 'production' : ''}`} />{e.name}{e.isProduction && <span className="production-tag">生产</span>}</th>)}</tr></thead><tbody>{services.map(s => <tr key={s.id}><th>{s.name}</th>{environments.map(e => {
      const b = w.bindings.find(b => b.serviceId === s.id && b.environmentId === e.id);
      const patch = (changes: { baseUrl?: string; enabled?: boolean }) => mutate(ws => ({ ...ws, bindings: b ? ws.bindings.map(x => x.id === b.id ? { ...x, ...changes } : x) : [...ws.bindings, { id: uid(), projectId: project!.id, serviceId: s.id, environmentId: e.id, baseUrl: '', enabled: true, ...changes }] }));
      return <td key={e.id}><input aria-label={`${s.name} ${e.name} 基础地址`} value={b?.baseUrl ?? ''} placeholder="https://api.example.com/v1" onChange={event => patch({ baseUrl: event.target.value })} /><div className="matrix-controls"><label className="checkbox-label"><input type="checkbox" checked={b?.enabled ?? false} onChange={event => patch({ enabled: event.target.checked })} />启用绑定</label>{b && <button className="icon-button" aria-label={`移除 ${s.name} ${e.name} 绑定`} onClick={async () => { if (await model.confirm({ title: '移除环境绑定？', message: '将同时删除此绑定层变量。该服务在此环境将无法发送请求。', danger: true, confirmLabel: '移除绑定' })) mutate(ws => ({ ...ws, bindings: ws.bindings.filter(x => x.id !== b.id), variables: ws.variables.filter(v => !(v.scope === 'binding' && v.ownerId === b.id)) })); }}><Trash2 size={14} /></button>}</div></td>;
    })}</tr>)}</tbody></table></div>}
    <div className="info-card"><Globe2 size={19} /><div><strong>环境地址与接口路径分开维护</strong><p>基础地址可包含网关前缀。接口编辑区只需填写相对路径；最终地址由桌面端解析并脱敏预览。</p></div></div>
  </section>;
}
