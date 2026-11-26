import { useRef, useState } from 'react';
import type { Workbench } from '../hooks/useWorkbench';
import { parseOpenApi, previewOpenApi, type OpenApiPreview, type OpenApiRow } from '../lib/openapi';
import { MAX_BYTES } from '../lib/transfer-adapters/shared';
import { errorMessage } from '../lib/workspace';
import { Dialog } from './Dialog';
import './openapi-import.css';

const statuses: Record<OpenApiRow['kind'], string> = {
  added: '新增', changed: '变化', unchanged: '无变化', removed: '文档已移除 / 未列出', blocked: '已阻止',
};
const selectable = (row: OpenApiRow) => row.kind === 'added' || row.kind === 'changed';

export function OpenApiImportDialog({ model, onClose }: { model: Workbench; onClose: () => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'new' | 'update'>('new');
  const [projectId, setProjectId] = useState(model.project?.id ?? model.workspace.projects[0]?.id ?? '');
  const [serviceId, setServiceId] = useState(model.workspace.services.find(s => s.projectId === projectId)?.id ?? '');
  const [plan, setPlan] = useState<OpenApiPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const current = useRef(model);
  current.current = model;
  const capturedWorkspace = useRef(model.workspace);
  const stale = !!plan && capturedWorkspace.current !== model.workspace;
  const blocked = pending || model.busy || model.loading || !!model.confirmation;
  const services = model.workspace.services.filter(s => s.projectId === projectId);
  const invalidate = () => { setPlan(null); setSelected([]); setError(''); };
  const preview = () => {
    if (blocked || lock.current) return;
    invalidate();
    try {
      const parsed = parseOpenApi(text);
      const next = previewOpenApi(current.current.workspace, parsed, mode === 'update' ? { projectId, serviceId } : undefined);
      capturedWorkspace.current = current.current.workspace;
      setPlan(next);
      // Updates require explicit selection; new imports select supported rows.
      setSelected(mode === 'new' ? next.rows.filter(selectable).map(r => r.key) : []);
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const read = async (file?: File) => {
    if (!file || blocked || lock.current) return;
    invalidate(); lock.current = true; setPending(true);
    try {
      if (file.size > MAX_BYTES) throw new Error('文档大小超过 10 MiB 上限');
      const content = await file.text();
      setText(content);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setPending(false); }
  };
  const submit = async () => {
    if (blocked || lock.current || !plan || stale || !selected.length) return;
    lock.current = true; setPending(true); setError('');
    try {
      if (await current.current.applyOpenApi(plan, selected)) onClose();
      else setError('应用失败：工作区可能已变更或当前操作被占用，请重新预览后确认。');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setPending(false); }
  };
  return <Dialog title="OpenAPI 导入与更新" wide className="openapi-import-dialog" onClose={() => { if (!blocked) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (plan) void submit(); else preview(); }}>
      <div className="form-fields">
        <p className="hint">离线读取 OpenAPI 3.0 / 3.1、Swagger 2 JSON 或 YAML（≤ 10 MiB）。先预览，再确认所选为未保存草稿。</p>
        <div className="openapi-targets">
          <label>导入方式<select disabled={blocked} value={mode} onChange={event => { setMode(event.target.value as typeof mode); invalidate(); }}>
            <option value="new">创建新项目</option><option value="update">更新已有服务</option>
          </select></label>
          {mode === 'update' && <>
            <label>目标项目<select disabled={blocked} value={projectId} onChange={event => {
              const id = event.target.value;
              setProjectId(id); setServiceId(model.workspace.services.find(s => s.projectId === id)?.id ?? ''); invalidate();
            }}>
              <option value="">请选择项目</option>
              {model.workspace.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
            <label>目标服务<select disabled={blocked} value={serviceId} onChange={event => { setServiceId(event.target.value); invalidate(); }}>
              <option value="">请选择服务</option>
              {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          </>}
        </div>
        <label>选择 JSON/YAML 文件<input type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" disabled={blocked} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''; void read(file);
        }} /></label>
        <label>OpenAPI 文档<textarea autoFocus rows={plan ? 5 : 10} disabled={blocked} value={text} onChange={event => { setText(event.target.value); invalidate(); }} spellCheck={false} /></label>
        <p className="hint">仅展开有预算限制的本地引用；不会读取远程引用、执行脚本或发送请求。路径 {'{id}'} 转换为 {'{{id}}'}，更新按转换后的 method + path 精确匹配。</p>
        {plan && <>
          <div className="openapi-policy">
            {mode === 'update'
              ? <p>只补共享模板缺失的 Query/Header 字段；保留本地名称、目录、参数值与启用状态、token/auth、body/form、超时、变量、绑定地址。所有环境覆盖原样保留，新字段需在已有环境覆盖中手动补齐。文档已移除项仅提示。</p>
              : <p>新建项目、服务、导入环境和所选接口。首个 tag 映射目录；支持的根服务器地址填入新环境绑定。凭据需自行配置。</p>}
          </div>
          <details className="openapi-warnings"><summary>解析说明与警告（{plan.warnings.length}）</summary>
            {plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          </details>
          <div className="openapi-selection">
            <span role="status">{plan.rows.length} 项 / 已选 {selected.length} 项</span>
            <button type="button" disabled={blocked || stale} onClick={() => setSelected(plan.rows.filter(selectable).map(r => r.key))}>选择可应用项</button>
            <button type="button" disabled={blocked || stale} onClick={() => setSelected([])}>清空选择</button>
          </div>
          <ul className="openapi-rows" aria-label="接口变更预览">
            {plan.rows.map(row => <li key={row.key}>
              <label className="openapi-row-title">
                <input type="checkbox" aria-label={row.label} disabled={blocked || stale || !selectable(row)} checked={selected.includes(row.key)} onChange={event => {
                  setSelected(keys => event.target.checked ? [...keys, row.key] : keys.filter(key => key !== row.key));
                }} />
                <span className={`openapi-status openapi-status-${row.kind}`}>{statuses[row.kind]}</span>
                <code>{row.label}</code>
              </label>
              {row.updates.map((update, index) => <p className="openapi-update" key={`u${index}`}>{update}</p>)}
              {row.warnings.map((warning, index) => <p className="openapi-note" key={`w${index}`}>{warning}</p>)}
            </li>)}
          </ul>
        </>}
        {(error || stale) && <p className="error-box" role="alert">{stale ? '工作区已变更，预览已过期；请重新预览。' : error}</p>}
      </div>
      <footer className="dialog-footer">
        <button type="button" disabled={blocked} onClick={onClose}>取消</button>
        <button type="button" disabled={blocked || !text.trim() || (mode === 'update' && (!projectId || !serviceId))} onClick={preview}>预览变更</button>
        {plan && <button className="primary" type="submit" disabled={blocked || stale || !selected.length}>{pending ? '处理中…' : '确认所选为草稿'}</button>}
      </footer>
    </form>
  </Dialog>;
}
