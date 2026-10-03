import { lazy, Suspense, useState } from 'react';
import { ArrowUpRight, Eye, Save, Send, Square } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { RequestDefinition } from '../types';
import { desktop } from '../lib/ipc';
import { PairsEditor } from './PairsEditor';
import { VariablesEditor } from './VariablesEditor';
import { AuthEditor } from './AuthEditor';
import { FormEditor } from './FormEditor';

const CodeEditor = lazy(() => import('./CodeEditor'));

export function RequestEditor({ model }: { model: Workbench }) {
  const [tab, setTab] = useState('query');
  const { request, workspace, execution } = model;
  if (!request) return null;
  const update = (patch: Partial<RequestDefinition>) => model.mutate(w => ({ ...w, requests: w.requests.map(r => r.id === request.id ? { ...r, ...patch } : r) }));
  const binding = workspace.bindings.find(b => b.serviceId === request.serviceId && b.environmentId === model.environment?.id);
  const service = workspace.services.find(s => s.id === request.serviceId);
  const tabs = [{ id: 'query', label: '参数', count: request.query.length }, { id: 'headers', label: 'Headers', count: request.headers.length }, { id: 'auth', label: '鉴权' }, { id: 'body', label: 'Body' }, { id: 'variables', label: '变量' }];
  return <section className="request-editor">
    <header className="request-heading"><div><div className="breadcrumb">{model.project?.name}<span>/</span>{service?.name}<span>/</span>接口</div><h1>{request.name}{model.dirty && <span className="dirty-dot" title="工作区有未保存修改" />}</h1></div><div className="request-actions"><button disabled={!desktop || !model.environment || model.busy} onClick={() => void model.copyCurl()}>复制脱敏 cURL</button><button onClick={() => void model.save()} disabled={model.busy || !desktop}><Save size={15} />保存工作区</button></div></header>
    {model.environment?.isProduction && <p className="warning-line">当前为生产环境；发送前需再次确认。取消请求不代表回滚。</p>}
    <div className="url-bar"><select aria-label="请求方法" value={request.method} onChange={e => update({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => <option key={m}>{m}</option>)}</select><input aria-label="接口路径" spellCheck={false} value={request.path} placeholder="/users/{{userId}}" onChange={e => update({ path: e.target.value })} />{execution?.running ? <button className="cancel-button" disabled={execution.cancelRequested} onClick={() => void model.cancel()}><Square size={14} />{execution.cancelRequested ? '取消中' : '取消'}</button> : <button className="primary send-button" title="Ctrl + Enter" disabled={!desktop || !model.environment || model.busy} onClick={() => void model.execute()}><Send size={15} />发送<kbd>⌃ ↵</kbd></button>}</div>
    <div className="url-preview"><ArrowUpRight size={13} /><span className="ellipsis">{model.preview?.url ?? (desktop ? binding?.enabled ? '点击预览，查看原生解析后的脱敏地址' : '当前环境尚未启用地址绑定' : '浏览器模式不解析凭据、不发送网络请求')}</span><button className="text-button" disabled={!desktop || !model.environment || model.busy} onClick={() => void model.execute(true)}><Eye size={13} />脱敏预览</button></div>
    <div className="editor-tabs" role="tablist" aria-label="请求配置">{tabs.map(t => <button role="tab" key={t.id} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}{!!t.count && <small>{t.count}</small>}</button>)}<label className="timeout-label">超时<input aria-label="超时时间（毫秒）" type="number" min="1" max="300000" value={request.timeoutMs} onChange={e => update({ timeoutMs: Number(e.target.value) })} />ms</label></div>
    <div className="editor-content" role="tabpanel" aria-label={tabs.find(t => t.id === tab)?.label}>
      {tab === 'query' && <><p className="hint">参数会附加到 URL；取消勾选的项不会发送。支持 <code>{'{{变量名}}'}</code>。</p><PairsEditor value={request.query} onChange={query => update({ query })} /></>}
      {tab === 'headers' && <><p className="hint">服务公共 Headers：{service?.headers?.filter(h => h.enabled).length ?? 0} 项。同名接口 Header（不区分大小写）覆盖服务同名组；接口重复项保留。凭据请使用秘密变量引用。</p><PairsEditor label="请求头" value={request.headers} onChange={headers => update({ headers })} /></>}
      {tab === 'auth' && <><p className="hint">服务默认鉴权：{service?.auth?.kind ?? 'none'}。公共配置在「工作区管理」中编辑。</p><AuthEditor key={request.id} value={request.auth} onChange={auth => update({ auth })} inherited /></>}
      {tab === 'body' && <><div className="body-toolbar"><label>正文类型 <select aria-label="正文类型" value={request.bodyType} onChange={e => { const bodyType = e.target.value as RequestDefinition['bodyType']; update({ bodyType, ...(bodyType === 'form' ? { form: (request.form ?? []).map(f => f.kind === 'file' ? { ...f, enabled: false } : f) } : {}) }); }}><option value="none">无正文</option><option value="json">JSON</option><option value="text">文本</option><option value="form">x-www-form-urlencoded</option><option value="multipart">multipart/form-data</option></select></label>{request.bodyType === 'json' && <button className="text-button" onClick={() => { try { update({ body: JSON.stringify(JSON.parse(request.body), null, 2) }); } catch { model.setNotice('JSON 格式无效，无法格式化；请检查正文。'); } }}>格式化 JSON</button>}</div>{request.bodyType === 'none' ? <div className="table-empty">此请求不发送正文。选择正文类型后开始编辑。</div> : request.bodyType === 'form' || request.bodyType === 'multipart' ? <FormEditor key={request.id} value={request.form ?? []} multipart={request.bodyType === 'multipart'} onChange={form => update({ form })} pickFile={desktop ? model.pickFile : undefined} disabled={model.busy} /> : <Suspense fallback={<div className="table-empty">正在加载正文编辑器…</div>}><CodeEditor value={request.body} isJson={request.bodyType === 'json'} disabled={model.busy} onChange={body => update({ body })} /></Suspense>}</>}
      {tab === 'variables' && <VariablesEditor model={model} />}
    </div>
  </section>;
}
