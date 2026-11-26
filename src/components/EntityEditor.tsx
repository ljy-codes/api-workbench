import { useState } from 'react';
import type { Workbench } from '../hooks/useWorkbench';
import { newRequest, uid, type EntityKind } from '../lib/workspace';
import { Dialog } from './Dialog';
import { ColorPicker, displayColor, ENVIRONMENT_COLOR, isHexColor, PROJECT_COLOR } from './ColorPicker';

export const entityLabels: Record<EntityKind, string> = { project: '项目', environment: '环境', service: '服务', folder: '目录', request: '接口' };
export type EntityEditTarget = { kind: EntityKind; id?: string; serviceId?: string; parentId?: string | null };
type EditState = { kind: EntityKind; id?: string; name: string; serviceId: string; parentId: string; isProduction: boolean; color: string };

export function EntityEditor({ model, target, onClose }: { model: Workbench; target: EntityEditTarget; onClose: () => void }) {
  const { workspace: w, project, mutate } = model;
  const services = w.services.filter(s => s.projectId === project?.id);
  const folders = w.folders.filter(f => services.some(s => s.id === f.serviceId));
  const collections = {
    project: w.projects, environment: w.environments.filter(e => e.projectId === project?.id),
    service: services, folder: folders,
    request: w.requests.filter(r => services.some(s => s.id === r.serviceId)),
  };
  const [editing, setEditing] = useState<EditState>(() => {
    const entity = collections[target.kind].find(r => r.id === target.id);
    return {
      kind: target.kind, id: target.id, name: entity?.name ?? '',
      serviceId: entity && 'serviceId' in entity ? entity.serviceId : target.serviceId ?? services[0]?.id ?? '',
      parentId: entity && 'parentId' in entity ? entity.parentId ?? '' : entity && 'folderId' in entity ? entity.folderId ?? '' : target.parentId ?? '',
      isProduction: entity && 'isProduction' in entity ? entity.isProduction : false,
      color: displayColor(entity && 'color' in entity ? entity.color : undefined, target.kind === 'environment' ? ENVIRONMENT_COLOR : PROJECT_COLOR),
    };
  });
  const [error, setError] = useState('');
  const descendants = new Set<string>();
  if (editing.kind === 'folder' && editing.id) {
    descendants.add(editing.id);
    let size = -1;
    while (size !== descendants.size) { size = descendants.size; folders.forEach(f => { if (f.parentId && descendants.has(f.parentId)) descendants.add(f.id); }); }
  }
  const submit = () => {
    if (model.busy || model.loading) return;
    const e = editing;
    const name = e.name.trim();
    if (!name) { setError('名称不能为空'); return; }
    if ((e.kind === 'project' || e.kind === 'environment') && !isHexColor(e.color)) return;
    if (e.kind !== 'project' && !project) { setError('请先创建并选择项目'); return; }
    if (e.kind === 'folder' || e.kind === 'request') {
      if (!services.some(s => s.id === e.serviceId)) { setError('请选择当前项目下的有效服务'); return; }
      if (e.parentId && !folders.some(f => f.id === e.parentId && f.serviceId === e.serviceId && !descendants.has(f.id))) {
        setError('请选择所属服务下的有效目录'); return;
      }
    }
    const duplicate = collections[e.kind].some(r => r.id !== e.id && r.name === name && (!('serviceId' in r) || r.serviceId === e.serviceId) && (!('parentId' in r) || r.parentId === (e.parentId || null)) && (!('folderId' in r) || r.folderId === (e.parentId || null)));
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
    onClose();
  };
  return <Dialog title={`${editing.id ? '编辑' : '新建'}${entityLabels[editing.kind]}`} onClose={onClose}><form onSubmit={event => { event.preventDefault(); submit(); }}><fieldset className="entity-editor" disabled={model.busy || model.loading}>
    <div className="form-fields"><label>名称<input autoFocus required maxLength={120} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder={`输入${entityLabels[editing.kind]}名称`} /></label>
      {(editing.kind === 'project' || editing.kind === 'environment') && <ColorPicker label={`${entityLabels[editing.kind]}颜色`} value={editing.color} onChange={color => setEditing({ ...editing, color })} />}
      {editing.kind === 'environment' && <label className="checkbox-label"><input type="checkbox" checked={editing.isProduction} onChange={e => setEditing({ ...editing, isProduction: e.target.checked })} />这是生产环境（每次发送都会确认）</label>}
      {(editing.kind === 'folder' || editing.kind === 'request') && <><label>所属服务<select required value={editing.serviceId} disabled={editing.kind === 'folder' && !!editing.id} onChange={e => setEditing({ ...editing, serviceId: e.target.value, parentId: '' })}><option value="">请选择服务</option>{services.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label><label>{editing.kind === 'folder' ? '上级目录' : '所属目录'}<select value={editing.parentId} onChange={e => setEditing({ ...editing, parentId: e.target.value })}><option value="">服务根目录</option>{folders.filter(f => f.serviceId === editing.serviceId && !descendants.has(f.id)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label></>}
      {error && <p role="alert" className="danger-text">{error}</p>}
    </div><footer className="dialog-footer"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit">应用到工作区</button></footer>
  </fieldset></form></Dialog>;
}
