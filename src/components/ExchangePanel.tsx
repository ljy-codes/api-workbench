import { useState } from 'react';
import type { Workbench } from '../hooks/useWorkbench';
import { desktop } from '../lib/ipc';
import { Dialog } from './Dialog';

export function ExchangePanel({ model }: { model: Workbench }) {
  const [mode, setMode] = useState<'project' | 'curl' | null>(null);
  const [text, setText] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [failed, setFailed] = useState(false);
  const open = (next: 'project' | 'curl') => { setText(''); setServiceName(''); setFailed(false); setMode(next); };
  return <section className="exchange-panel" aria-label="导入导出与备份">
    <h2>导入、导出与备份</h2>
    <p className="hint">导入不执行网络请求、不覆盖现有项目；仅生成待保存草稿。秘密需重新填写，上传文件需重新选择。备份仅包含已保存数据。</p>
    <div className="exchange-actions">
      <button disabled={!desktop || model.busy} onClick={() => void model.readProject()}>从文件导入项目</button>
      <button disabled={model.busy} onClick={() => open('project')}>粘贴项目 JSON</button>
      <button disabled={!model.project || !model.environment || model.busy} onClick={() => open('curl')}>导入 cURL</button>
      <button disabled={!desktop || !model.project || model.busy} onClick={() => void model.writeProject()}>导出当前项目</button>
      <button disabled={!desktop || model.busy} onClick={() => void model.backup()}>备份已保存工作区</button>
    </div>
    {!desktop && <p className="hint">文件读写、原生脱敏 cURL 导出和 SQLite 备份仅在桌面版可用；粘贴导入可在内存中试用。</p>}
    {mode && <Dialog title={mode === 'curl' ? '导入 cURL' : '粘贴项目 JSON'} wide onClose={() => { if (!model.busy) setMode(null); }}>
      <form onSubmit={async e => {
        e.preventDefault();
        setFailed(false);
        const success = mode === 'curl' ? await model.importCurlText(text, serviceName.trim() || undefined) : await model.importProjectText(text);
        if (success) { setMode(null); setText(''); }
        else setFailed(true);
      }}>
        <div className="form-fields">
          <p className="hint">{mode === 'curl' ? `仅解析命令，绝不执行 shell。新服务将绑定当前环境「${model.environment?.name}」。不支持的参数会明确报错。` : '只接受 api-workbench 项目交换格式。自动分配新 ID，重名项目自动加后缀。'}</p>
          {mode === 'curl' && <label>新服务名称（可选）<input disabled={model.busy} value={serviceName} onChange={e => setServiceName(e.target.value)} maxLength={120} /></label>}
          <label>{mode === 'curl' ? 'cURL 命令' : '项目 JSON'}<textarea autoFocus required disabled={model.busy} rows={12} value={text} onChange={e => setText(e.target.value)} spellCheck={false} /></label>
          {failed && <p className="error-box" role="alert">{model.notice || '导入未完成，请检查内容后重试。'}</p>}
        </div>
        <footer className="dialog-footer"><button type="button" disabled={model.busy} onClick={() => setMode(null)}>取消</button><button type="submit" className="primary" disabled={model.busy || !text.trim()}>导入为草稿</button></footer>
      </form>
    </Dialog>}
  </section>;
}
