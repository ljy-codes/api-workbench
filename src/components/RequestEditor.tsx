import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { formatJson } from '../lib/json-format';
import { ArrowUpRight, Braces, Clock3, Copy, Ellipsis, Eye, Send, Square, WandSparkles } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { TemporaryRequestsModel } from '../hooks/useTemporaryRequests';
import type { Environment, RequestDefinition, Service } from '../types';
import { desktop } from '../lib/ipc';
import { PairsEditor } from './PairsEditor';
import { VariablesEditor } from './VariablesEditor';
import { AuthEditor } from './AuthEditor';
import { FormEditor } from './FormEditor';

const CodeEditor = lazy(() => import('./CodeEditor'));

export function RequestEditor({ model, onConfigureAddresses, onTemporaryRequest }: { model: Workbench; onConfigureAddresses?: () => void; onTemporaryRequest?: () => void }) {
  const binding = model.workspace.bindings.find(b => b.serviceId === model.request?.serviceId && b.environmentId === model.environment?.id);
  const service = model.workspace.services.find(s => s.id === model.request?.serviceId);
  return <RequestEditorContent model={model} environment={model.environment} service={service}
    baseUrl={binding?.enabled ? binding.baseUrl : undefined} copyCurl={model.copyCurl} onTemporaryRequest={onTemporaryRequest}
    variables={<VariablesEditor model={model} onConfigureAddresses={onConfigureAddresses} />} />;
}

export function TemporaryRequestEditor({ model }: { model: TemporaryRequestsModel }) {
  return <RequestEditorContent model={model} temporary />;
}

type EditorModel = Pick<Workbench, 'request' | 'execution' | 'preview' | 'busy' | 'updateRequest' | 'execute' | 'cancel' | 'setNotice'> & {
  pickFile: () => Promise<string | null>;
};
function RequestEditorContent({ model, temporary = false, environment, service, baseUrl, copyCurl, variables, onTemporaryRequest }: {
  model: EditorModel; temporary?: boolean; environment?: Environment; service?: Service;
  baseUrl?: string; copyCurl?: () => Promise<void>; variables?: ReactNode; onTemporaryRequest?: () => void;
}) {
  const [tab, setTab] = useState(model.request?.bodyType !== 'none' ? 'body' : 'query');
  const menu = useRef<HTMLDetailsElement>(null);
  const { request, execution } = model;
  if (!request) return null;
  const update = (patch: Partial<RequestDefinition>) => model.updateRequest(patch);
  const canEdit = temporary || !!environment;
  const tabs = [
    { id: 'query', label: 'Params', count: request.query.length },
    { id: 'headers', label: 'Headers', count: request.headers.length },
    { id: 'auth', label: 'Auth' }, ...(!temporary ? [{ id: 'variables', label: '变量' }] : []),
  ];
  const tabLabel = tab === 'body' ? 'Body' : tabs.find(t => t.id === tab)?.label;
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const preview = () => { closeMenu(); void model.execute(true); };
  const formatBody = () => {
    try { update({ body: formatJson(request.body, { removeNull: true }) }); }
    catch { model.setNotice('JSON 格式无效，无法格式化；请检查正文。'); }
  };
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(request.body);
      model.setNotice('已复制完整请求体。');
    } catch {
      model.setNotice('复制失败，请点击请求体后按 Ctrl/Cmd+A 全选，再按 Ctrl/Cmd+C 复制。');
    }
  };
  return <section className="request-editor" aria-label="请求编辑">
    {environment?.isProduction && <p className="warning-line">当前为生产环境；发送前需再次确认。取消请求不代表回滚。</p>}
    <div className="url-bar">
      <select className={`method-${request.method}`} aria-label="请求方法" value={request.method} onChange={e => update({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => <option key={m}>{m}</option>)}</select>
      <input aria-label={temporary ? '请求完整地址' : '接口路径'} autoComplete="off" spellCheck={false} value={request.path} title={temporary ? '输入完整 HTTP/HTTPS 地址，无需配置环境' : baseUrl ?? '当前环境尚未启用地址绑定'} placeholder={temporary ? 'https://example.com/api/users' : '/users/{{userId}}'} onChange={e => update({ path: e.target.value })} />
      {execution?.running
        ? <button className="cancel-button" aria-label={execution.cancelRequested ? '取消中' : '取消请求'} title="取消请求" disabled={execution.cancelRequested} onClick={() => void model.cancel()}><Square size={15} /></button>
        : <button className="primary send-button" aria-label="发送请求" title="发送请求 · Ctrl/Cmd+Enter" disabled={!desktop || !canEdit || model.busy} onClick={() => void model.execute()}><Send size={17} /></button>}
    </div>
    <div className="url-preview">
      <ArrowUpRight size={13} /><span className="ellipsis" title={model.preview?.url}>{model.preview?.url ?? (desktop ? temporary || baseUrl ? '正在解析脱敏地址…' : '当前环境尚未启用地址绑定' : '浏览器模式不解析凭据、不发送网络请求')}</span>
    </div>
    <div className="editor-tabs">
      <div className="request-config-tabs" role="tablist" aria-label="请求配置">
        <div className="body-type-tab" data-active={tab === 'body'}>
          <button role="tab" aria-label="Body" aria-selected={tab === 'body'} title="请求正文" onClick={() => setTab('body')}><Braces size={14} /></button>
          <select aria-label="正文类型" value={request.bodyType} disabled={!canEdit || model.busy} onFocus={() => setTab('body')} onChange={e => {
            const bodyType = e.target.value as RequestDefinition['bodyType'];
            setTab('body');
            update({ bodyType, ...(bodyType === 'form' ? { form: (request.form ?? []).map(f => f.kind === 'file' ? { ...f, enabled: false } : f) } : {}) });
          }}>
            <option value="none">Body</option><option value="json">JSON</option><option value="text">Text</option><option value="form">Form URL</option><option value="multipart">Multipart</option>
          </select>
        </div>
        {tabs.map(t => <button role="tab" key={t.id} aria-label={t.id === 'query' ? '参数' : t.id === 'auth' ? '鉴权' : undefined} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}{!!t.count && <small>{t.count}</small>}</button>)}
      </div>
      <div className="editor-tools">
        {copyCurl && <button type="button" className="icon-button request-curl-copy" aria-label="复制脱敏 cURL" title="复制脱敏 cURL" disabled={!desktop || !canEdit || model.busy} onClick={() => void copyCurl()}><Copy size={14} aria-hidden="true" />复制 cURL</button>}
        <button type="button" className="icon-button timeout-trigger" aria-label={`超时 ${Math.round(request.timeoutMs / 1000)}s`} title="设置请求超时" disabled={!canEdit || model.busy} onClick={() => { if (menu.current) menu.current.open = true; }}><Clock3 size={14} aria-hidden="true" />{Math.round(request.timeoutMs / 1000)}s</button>
        {tab === 'body' && ['json', 'text'].includes(request.bodyType) && <button type="button" className="icon-button request-body-copy" aria-label="复制请求体" title="复制完整请求体（保留原文与变量占位符）" disabled={!request.body.length || model.busy} onClick={() => void copyBody()}><Copy size={14} aria-hidden="true" />复制</button>}
        {tab === 'body' && request.bodyType === 'json' && <button className="icon-button" aria-label="格式化 JSON" title="格式化 JSON · 去除 null 字段和末尾多余逗号" disabled={!canEdit || model.busy} onClick={formatBody}><WandSparkles size={14} /></button>}
        <details className="request-menu" ref={menu} onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
        }} onKeyDown={event => {
          if (event.key === 'Escape') { closeMenu(); menu.current?.querySelector('summary')?.focus(); }
        }}>
          <summary className="icon-button" aria-label="更多请求操作" title="更多请求操作"><Ellipsis size={17} /></summary>
          <div className="request-menu-panel">
            <button disabled={!desktop || !canEdit || model.busy} onClick={preview}><Eye size={14} />脱敏预览</button>
            {copyCurl && <button aria-label="菜单中复制脱敏 cURL" disabled={!desktop || !canEdit || model.busy} onClick={() => { closeMenu(); void copyCurl(); }}><Copy size={14} />复制脱敏 cURL</button>}
            <label className="timeout-label">超时<input aria-label="超时时间（毫秒）" type="number" disabled={!canEdit || model.busy} min="1" max="300000" value={request.timeoutMs} onChange={e => update({ timeoutMs: Number(e.target.value) })} />ms</label>
            <p className="hint">{temporary ? '直接填写完整地址、参数与凭据；无需环境，不继承项目变量或服务配置。取消请求不代表服务端回滚。' : <>参数支持 {'{{变量名}}'}；未启用的项不会发送。服务公共 Headers：{service?.headers?.filter(h => h.enabled).length ?? 0} 项，同名接口项覆盖服务配置。默认鉴权：{service?.auth?.kind ?? 'none'}。公共配置在工作区管理中编辑。</>}</p>
          </div>
        </details>
      </div>
    </div>
    {!canEdit && <p className="warning-line">请先选择环境再编辑请求参数、鉴权与正文；接口路径在所有环境共用。{onTemporaryRequest && <button className="text-button" onClick={onTemporaryRequest}>没有环境？临时调试</button>}</p>}
    <fieldset className={`editor-content ${tab === 'body' && ['json', 'text'].includes(request.bodyType) ? 'body-content' : ''}`} role="tabpanel" aria-label={tabLabel} disabled={!canEdit || model.busy}>
      {tab === 'query' && <PairsEditor value={request.query} onChange={query => update({ query })} />}
      {tab === 'headers' && <PairsEditor label="请求头" value={request.headers} onChange={headers => update({ headers })} />}
      {tab === 'auth' && <AuthEditor key={request.id} value={request.auth} onChange={auth => update({ auth })} inherited={!temporary} temporary={temporary} />}
      {tab === 'body' && (request.bodyType === 'none'
        ? <div className="table-empty">此请求不发送正文。在上方选择正文类型后开始编辑。</div>
        : request.bodyType === 'form' || request.bodyType === 'multipart'
          ? <FormEditor key={request.id} value={request.form ?? []} multipart={request.bodyType === 'multipart'} onChange={form => update({ form })} pickFile={desktop ? model.pickFile : undefined} disabled={model.busy} />
          : <Suspense fallback={<div className="table-empty">正在加载正文编辑器…</div>}><CodeEditor value={request.body} isJson={request.bodyType === 'json'} disabled={!canEdit || model.busy} onChange={body => update({ body })} /></Suspense>)}
      {tab === 'variables' && variables}
    </fieldset>
  </section>;
}
