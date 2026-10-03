import { useState } from 'react';
import { Box, FolderClosed, Globe2, Pencil, Plus, Server, Trash2, Waypoints } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { cascadeDelete, newRequest, uid, type EntityKind } from '../lib/workspace';
import { Dialog } from './Dialog';
import { AuthEditor } from './AuthEditor';
import { PairsEditor } from './PairsEditor';
import { ExchangePanel } from './ExchangePanel';
import { ColorDot, ColorPicker, displayColor, ENVIRONMENT_COLOR, isHexColor, PROJECT_COLOR } from './ColorPicker';
import { DataCleanup } from './DataCleanup';

const labels: Record<EntityKind, string> = { project: '项目', environment: '环境', service: '服务', folder: '目录', request: '接口' };
type EditState = { kind: EntityKind; id?: string; name: string; serviceId: string; parentId: string; isProduction: boolean; color: string };

export function EntityManager({ model }: { model: Workbench }) {
  const { workspace: w, project, mutate } = model;
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState('');
  const services = w.services.filter(s => s.projectId === project?.id);
  const folders = w.folders.filter(f => services.some(s => s.id === f.serviceId));
  const requests = w.requests.filter(r => services.some(s => s.id === r.serviceId));
  const collections = [
    { kind: 'project' as const, icon: Box, rows: w.projects },
    { kind: 'environment' as const, icon: Globe2, rows: w.environments.filter(e => e.projectId === project?.id) },
    { kind: 'service' as const, icon: Server, rows: services },
    { kind: 'folder' as const, icon: FolderClosed, rows: folders },
    { kind: 'request' as const, icon: Waypoints, rows: requests },
  ];
  const edit = (kind: EntityKind, id?: string) => {
    const entity = collections.find(c => c.kind === kind)?.rows.find(r => r.id === id);
    setEditing({ kind, id, name: entity?.name ?? '', serviceId: entity && 'serviceId' in entity ? entity.serviceId : services[0]?.id ?? '', parentId: entity && 'parentId' in entity ? entity.parentId ?? '' : entity && 'folderId' in entity ? entity.folderId ?? '' : '', isProduction: entity && 'isProduction' in entity ? entity.isProduction : false, color: displayColor(entity && 'color' in entity ? entity.color : undefined, kind === 'environment' ? ENVIRONMENT_COLOR : PROJECT_COLOR) });
    setError('');
  };
  const remove = async (kind: EntityKind, id: string, name: string) => {
    const next = cascadeDelete(w, kind, id);
    const count = (key: 'projects' | 'environments' | 'services' | 'folders' | 'requests' | 'bindings' | 'variables') => w[key].length - next[key].length;
    const summary = (['projects', 'environments', 'services', 'folders', 'requests', 'bindings', 'variables'] as const).map((key, i) => `${count(key)} 个${['项目', '环境', '服务', '目录', '接口', '绑定', '变量'][i]}`).join('、');
    if (await model.confirm({ title: `删除${labels[kind]}「${name}」？`, message: `将关联删除：${summary}。保存后不可恢复；正在进行的请求不会因此自动取消。`, danger: true, confirmLabel: '确认关联删除' })) mutate(current => cascadeDelete(current, kind, id));
  };
  const submit = () => {
    if (!editing) return;
    const e = editing;
    const name = e.name.trim();
    if (!name) { setError('名称不能为空'); return; }
    if ((e.kind === 'project' || e.kind === 'environment') && !isHexColor(e.color)) return;
    if (e.kind !== 'project' && !project) { setError('请先创建并选择项目'); return; }
    if ((e.kind === 'folder' || e.kind === 'request') && !e.serviceId) { setError('请先创建服务'); return; }
    const rows = collections.find(c => c.kind === e.kind)!.rows;
    const duplicate = rows.some(r => r.id !== e.id && r.name === name && (!('serviceId' in r) || r.serviceId === e.serviceId) && (!('parentId' in r) || r.parentId === (e.parentId || null)) && (!('folderId' in r) || r.folderId === (e.parentId || null)));
    if (duplicate) { setError('同一位置已存在该名称，请使用不同名称'); return; }
    const id = e.id ?? uid();
    mutate(ws => {
      switch (e.kind) {
        case 'project': return { ...ws, activeProjectId: ws.activeProjectId ?? id, projects: e.id ? ws.projects.map(p => p.id === id ? { ...p, name, color: e.color.toUpperCase() } : p) : [...ws.projects, { id, name, color: e.color.toUpperCase(), activeEnvironmentId: null }] };
        case 'environment': return { ...ws, environments: e.id ? ws.environments.map(v => v.id === id ? { ...v, name, color: e.color.toUpperCase(), isProduction: e.isProduction } : v) : [...ws.environments, { id, name, color: e.color.toUpperCase(), projectId: project!.id, isProduction: e.isProduction }], projects: ws.projects.map(p => p.id === project!.id && !p.activeEnvironmentId ? { ...p, activeEnvironmentId: id } : p) };
        case 'service': return { ...ws, services: e.id ? ws.services.map(s => s.id === id ? { ...s, name } : s) : [...ws.services, { id, name, projectId: project!.id }] };
        case 'folder': return { ...ws, folders: e.id ? ws.folders.map(f => f.id === id ? { ...f, name, parentId: e.parentId || null } : f) : [...ws.folders, { id, name, serviceId: e.serviceId, parentId: e.parentId || null }] };
        case 'request': return { ...ws, requests: e.id ? ws.requests.map(r => r.id === id ? { ...r, name, serviceId: e.serviceId, folderId: e.parentId || null } : r) : [...ws.requests, { ...newRequest(e.serviceId, e.parentId || null, id), name }] };
      }
    });
    setEditing(null);
  };
  const descendants = new Set<string>();
  if (editing?.kind === 'folder' && editing.id) {
    descendants.add(editing.id);
    let size = -1;
    while (size !== descendants.size) { size = descendants.size; folders.forEach(f => { if (f.parentId && descendants.has(f.parentId)) descendants.add(f.id); }); }
  }
  return <section className="page-panel">
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>有条理地组织每一个接口</h1><p>管理项目、环境和服务。修改可用 Ctrl/Cmd+S 或「保存全部修改」保存，切换时自动保存；浏览器预览仅保留内存草稿。</p></div></div>
    <div className="management-grid">{collections.map(({ kind, icon: Icon, rows }) => <section className="management-card" key={kind}><header><h2><Icon size={17} />{labels[kind]}<small>{rows.length}</small></h2><button className="text-button" disabled={(kind !== 'project' && !project) || ((kind === 'folder' || kind === 'request') && !services.length)} onClick={() => edit(kind)}><Plus size={14} />新建{labels[kind]}</button></header>
      {!rows.length && <div className="table-empty">暂无{labels[kind]}</div>}
      {rows.map(row => <div className="entity-row" key={row.id}><div className="entity-name">{(kind === 'project' || kind === 'environment') && <ColorDot color={'color' in row ? row.color : undefined} fallback={kind === 'environment' ? ENVIRONMENT_COLOR : PROJECT_COLOR} />}<strong>{row.name}</strong>{'isProduction' in row && row.isProduction && <span className="production-tag">生产</span>}{'serviceId' in row && <small>{services.find(s => s.id === row.serviceId)?.name}</small>}{kind === 'project' && row.id === project?.id && <span className="badge">当前</span>}</div><button className="icon-button" aria-label={`编辑${labels[kind]} ${row.name}`} onClick={() => edit(kind, row.id)}><Pencil size={14} /></button><button className="icon-button danger-text" aria-label={`删除${labels[kind]} ${row.name}`} onClick={() => void remove(kind, row.id, row.name)}><Trash2 size={14} /></button></div>)}
    </section>)}</div>
    <section className="service-settings" aria-label="服务公共配置"><h2>服务公共 Headers 与鉴权</h2><p className="hint">作用于当前项目下服务的所有接口。接口可按名称覆盖 Header，或显式关闭鉴权继承。</p>
      {services.map(service => <details className="management-card" key={service.id}><summary>{service.name}</summary><div className="service-settings-body">
        <PairsEditor label="公共请求头" value={service.headers ?? []} onChange={headers => mutate(ws => ({ ...ws, services: ws.services.map(s => s.id === service.id ? { ...s, headers } : s) }))} />
        <AuthEditor value={service.auth} onChange={auth => mutate(ws => ({ ...ws, services: ws.services.map(s => s.id === service.id ? { ...s, auth } : s) }))} />
      </div></details>)}
      {!services.length && <p className="hint">创建服务后可配置公共 Headers 和鉴权。</p>}
    </section>
    <ExchangePanel model={model} />
    <DataCleanup model={model} />
    {editing && <Dialog title={`${editing.id ? '编辑' : '新建'}${labels[editing.kind]}`} onClose={() => setEditing(null)}><form onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="form-fields"><label>名称<input autoFocus required maxLength={120} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder={`输入${labels[editing.kind]}名称`} /></label>
        {(editing.kind === 'project' || editing.kind === 'environment') && <ColorPicker label={`${labels[editing.kind]}颜色`} value={editing.color} onChange={color => setEditing({ ...editing, color })} />}
        {editing.kind === 'environment' && <label className="checkbox-label"><input type="checkbox" checked={editing.isProduction} onChange={e => setEditing({ ...editing, isProduction: e.target.checked })} />这是生产环境（每次发送都会确认）</label>}
        {(editing.kind === 'folder' || editing.kind === 'request') && <><label>所属服务<select required value={editing.serviceId} disabled={editing.kind === 'folder' && !!editing.id} onChange={e => setEditing({ ...editing, serviceId: e.target.value, parentId: '' })}><option value="">请选择服务</option>{services.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label><label>{editing.kind === 'folder' ? '上级目录' : '所属目录'}<select value={editing.parentId} onChange={e => setEditing({ ...editing, parentId: e.target.value })}><option value="">服务根目录</option>{folders.filter(f => f.serviceId === editing.serviceId && !descendants.has(f.id)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label></>}
        {error && <p role="alert" className="danger-text">{error}</p>}
      </div><footer className="dialog-footer"><button type="button" onClick={() => setEditing(null)}>取消</button><button className="primary" type="submit">应用到工作区</button></footer>
    </form></Dialog>}
  </section>;
}
