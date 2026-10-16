import { useState } from 'react';
import { Box, FolderClosed, Globe2, Pencil, Plus, Server, Trash2, Waypoints } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { cascadeDelete, type EntityKind } from '../lib/workspace';
import { AuthEditor } from './AuthEditor';
import { PairsEditor } from './PairsEditor';
import { ExchangePanel } from './ExchangePanel';
import { ColorDot, ENVIRONMENT_COLOR, PROJECT_COLOR } from './ColorPicker';
import { DataCleanup } from './DataCleanup';
import { EntityEditor, entityLabels as labels, type EntityEditTarget } from './EntityEditor';

export function EntityManager({ model }: { model: Workbench }) {
  const { workspace: w, project, mutate } = model;
  const [editing, setEditing] = useState<EntityEditTarget | null>(null);
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
    setEditing({ kind, id });
  };
  const remove = async (kind: EntityKind, id: string, name: string) => {
    const next = cascadeDelete(w, kind, id);
    const count = (key: 'projects' | 'environments' | 'services' | 'folders' | 'requests' | 'bindings' | 'variables') => w[key].length - next[key].length;
    const summary = (['projects', 'environments', 'services', 'folders', 'requests', 'bindings', 'variables'] as const).map((key, i) => `${count(key)} 个${['项目', '环境', '服务', '目录', '接口', '绑定', '变量'][i]}`).join('、');
    if (await model.confirm({ title: `删除${labels[kind]}「${name}」？`, message: `将关联删除：${summary}。保存后不可恢复；正在进行的请求不会因此自动取消。`, danger: true, confirmLabel: '确认关联删除' })) mutate(current => cascadeDelete(current, kind, id));
  };
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
    {editing && <EntityEditor model={model} target={editing} onClose={() => setEditing(null)} />}
  </section>;
}
