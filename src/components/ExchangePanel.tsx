import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { ImportBundle, TransferSelection } from '../lib/transfer';
import { desktop } from '../lib/ipc';
import { errorMessage } from '../lib/workspace';
import { Dialog } from './Dialog';
import { allSelected, TransferTree } from './TransferTree';

export function ExchangePanel({ model }: { model: Workbench }) {
  const [mode, setMode] = useState<'project' | 'curl' | 'export' | null>(null);
  const [text, setText] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [selection, setSelection] = useState<TransferSelection>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const current = useRef(model);
  current.current = model;
  const blocked = pending || model.busy || model.loading;
  const close = () => { setMode(null); setText(''); setServiceName(''); setBundle(null); setSelection({}); setError(''); };
  const open = (next: typeof mode) => { setText(''); setServiceName(''); setBundle(null); setError(''); setSelection(next === 'export' ? allSelected(model.workspace) : {}); setMode(next); };
  const preview = async (content: string) => {
    const { detectImport } = await import('../lib/transfer');
    const detected = detectImport(content);
    setBundle(detected); setSelection(allSelected(detected.workspace));
  };
  const read = async () => {
    if (lock.current || blocked) return;
    lock.current = true; setPending(true); setError('');
    try {
      const content = await model.readTransferFile();
      if (content === null) return;
      open('project'); setText(content);
      await preview(content);
    } catch (failure) { setError(errorMessage(failure)); setMode('project'); }
    finally { lock.current = false; setPending(false); }
  };
  const submit = async () => {
    if (lock.current || blocked) return;
    lock.current = true; setPending(true); setError('');
    try {
      if (mode === 'project' && !bundle) { await preview(text); return; }
      const latest = current.current;
      const success = mode === 'curl' ? await latest.importCurlText(text, serviceName.trim() || undefined)
        : mode === 'export' ? await latest.writeSelected(selection)
          : bundle ? await latest.importSelected(bundle, selection) : false;
      if (success === null) return;
      if (success) close();
      else setError(current.current.notice || '操作未完成，请检查内容后重试。');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setPending(false); }
  };
  return <section className="exchange-panel" aria-label="导入导出与备份">
    <div className="eyebrow">IMPORT & EXPORT</div><h2>让数据自由流转</h2>
    <p className="hint">文件格式自动识别。预览后选择项目和环境，导入为新草稿。</p>
    <div className="exchange-actions">
      <button disabled={!desktop || blocked} onClick={() => void read()}><ArrowDownToLine size={15} />从文件导入</button>
      <button disabled={blocked} onClick={() => open('project')}>粘贴项目 JSON</button>
      <button disabled={!model.project || !model.environment || blocked} onClick={() => open('curl')}>导入 cURL</button>
      <button disabled={!desktop || !model.workspace.projects.length || blocked} onClick={() => open('export')}><ArrowUpFromLine size={15} />导出 JSON</button>
    </div>
    <p className="hint transfer-help">支持常见接口集合与环境文件。仅解析配置，不执行脚本或发送请求。凭据需重新填写，上传文件需重新选择。</p>
    {!desktop && <p className="hint">浏览器可试用文本导入；文件读写和备份请使用桌面版。</p>}
    {mode && <Dialog title={mode === 'curl' ? '导入 cURL' : mode === 'export' ? '导出 JSON' : '粘贴项目 JSON'} wide onClose={() => { if (!blocked) close(); }}>
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="form-fields">
          {mode === 'curl' ? <>
            <p className="hint">新服务绑定当前环境「{model.environment?.name}」。只解析命令，不执行 shell。</p>
            <label>新服务名称（可选）<input disabled={blocked} value={serviceName} onChange={e => setServiceName(e.target.value)} maxLength={120} /></label>
            <label>cURL 命令<textarea autoFocus required disabled={blocked} rows={10} value={text} onChange={e => setText(e.target.value)} spellCheck={false} /></label>
          </> : mode === 'export' ? <>
            <p className="hint">选择要导出的项目和环境。未选环境的地址和环境配置不会导出；接口路径与结构保留。</p>
            <TransferTree workspace={model.workspace} selection={selection} onChange={setSelection} disabled={blocked} />
            <p className="hint">已知凭据会脱敏，响应缓存不导出。普通正文仍可能包含业务数据，请检查后再分享。</p>
          </> : bundle ? <>
            <div className="transfer-summary"><strong>已识别 · {bundle.source}</strong><span>{bundle.workspace.projects.length} 个项目 / {bundle.workspace.requests.length} 个接口</span></div>
            <p className="hint">选择项目和环境。取消全部环境勾选时，仅导入项目结构及共享配置。</p>
            <TransferTree workspace={bundle.workspace} selection={selection} onChange={setSelection} disabled={blocked} />
            {bundle.warnings.length > 0 && <div className="transfer-warnings" role="status">{bundle.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
            <button type="button" className="text-button" disabled={blocked} onClick={() => { setBundle(null); setError(''); }}>返回编辑内容</button>
          </> : <>
            <p className="hint">粘贴 JSON 或 YAML，自动识别格式；下一步可选择项目和环境。</p>
            <label>项目 JSON<textarea autoFocus required disabled={blocked} rows={12} value={text} onChange={e => { setText(e.target.value); setError(''); }} spellCheck={false} /></label>
          </>}
          {error && <p className="error-box" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer"><button type="button" disabled={blocked} onClick={close}>取消</button><button type="submit" className="primary" disabled={blocked || (mode === 'curl' || (mode === 'project' && !bundle) ? !text.trim() : !Object.keys(selection).length)}>{pending ? '处理中…' : mode === 'export' ? '导出所选内容' : mode === 'project' && !bundle ? '预览内容' : '导入为草稿'}</button></footer>
      </form>
    </Dialog>}
  </section>;
}
