import type { Workspace } from '../types';
import type { TransferSelection } from '../lib/transfer';

export const allSelected = (workspace: Workspace): TransferSelection => Object.fromEntries(
  workspace.projects.map(project => [project.id, workspace.environments.filter(env => env.projectId === project.id).map(env => env.id)]),
);

export function TransferTree({ workspace, selection, onChange, disabled = false }: {
  workspace: Workspace; selection: TransferSelection; onChange: (selection: TransferSelection) => void; disabled?: boolean;
}) {
  const toggleProject = (id: string, checked: boolean) => {
    const next = { ...selection };
    if (checked) next[id] = workspace.environments.filter(env => env.projectId === id).map(env => env.id);
    else delete next[id];
    onChange(next);
  };
  return <div className="transfer-tree">
    <div className="transfer-tree-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => onChange(allSelected(workspace))}>全选</button><button type="button" className="text-button" disabled={disabled} onClick={() => onChange({})}>清空选择</button><span>{Object.keys(selection).length} 个项目已选</span></div>
    {workspace.projects.map(project => {
      const environments = workspace.environments.filter(env => env.projectId === project.id);
      const selected = Object.hasOwn(selection, project.id);
      const count = workspace.requests.filter(request => workspace.services.some(service => service.id === request.serviceId && service.projectId === project.id)).length;
      return <div className="transfer-project" key={project.id}>
        <label className="transfer-project-label"><input type="checkbox" checked={selected} disabled={disabled} onChange={e => toggleProject(project.id, e.target.checked)} /><strong>{project.name}</strong><small>{count} 个接口</small></label>
        <div className="transfer-environments">{environments.length ? environments.map(env => <label key={env.id}><input type="checkbox" checked={selected && selection[project.id].includes(env.id)} disabled={disabled} onChange={e => onChange({ ...selection, [project.id]: e.target.checked ? [...(selection[project.id] ?? []), env.id] : (selection[project.id] ?? []).filter(id => id !== env.id) })} />{env.name}{env.isProduction && <span className="production-tag">生产</span>}</label>) : <small>无环境</small>}</div>
      </div>;
    })}
  </div>;
}
