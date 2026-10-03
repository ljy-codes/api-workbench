import { useState } from 'react';
import type { FormField } from '../types';
import { errorMessage, uid } from '../lib/workspace';

export function FormEditor({ value, onChange, multipart, pickFile, disabled = false }: { value: FormField[]; onChange: (value: FormField[]) => void; multipart: boolean; pickFile?: () => Promise<string | null>; disabled?: boolean }) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const update = (id: string, patch: Partial<FormField>) => onChange(value.map(f => f.id === id ? { ...f, ...patch } : f));
  return <fieldset className="form-editor" disabled={disabled || picking}>
    <p className="hint">{multipart ? '支持重复文本与文件项。单文件 ≤ 10 MiB，总文件 ≤ 20 MiB；导入后须重新选择文件。' : 'application/x-www-form-urlencoded：仅发送文本项；重复名称会保留。'}</p>
    {value.map((field, index) => <div className="form-row" key={field.id}>
      <input type="checkbox" aria-label={`启用表单项${index + 1}`} disabled={!multipart && field.kind === 'file'} checked={field.enabled} onChange={e => update(field.id, { enabled: e.target.checked })} />
      <input aria-label={`表单名称${index + 1}`} placeholder="字段名" value={field.key} onChange={e => update(field.id, { key: e.target.value })} />
      <select aria-label={`表单类型${index + 1}`} value={field.kind} disabled={!multipart} onChange={e => update(field.id, { kind: e.target.value as FormField['kind'], value: '' })}><option value="text">文本</option><option value="file">文件</option></select>
      <input aria-label={`表单值${index + 1}`} readOnly={field.kind === 'file'} value={field.value} placeholder={field.kind === 'file' ? '请通过原生对话框选择' : '值或 {{变量名}}'} onChange={e => update(field.id, { value: e.target.value })} />
      {field.kind === 'file' && <button disabled={!pickFile || !multipart} aria-label={`选择文件${index + 1}`} onClick={async () => {
        if (!pickFile) return;
        setPicking(true); setError('');
        try { const path = await pickFile(); if (path !== null) update(field.id, { value: path }); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setPicking(false); }
      }}>选择文件</button>}
      <button aria-label={`删除表单项${index + 1}`} onClick={() => onChange(value.filter(f => f.id !== field.id))}>删除</button>
    </div>)}
    <button className="text-button" onClick={() => onChange([...value, { id: uid(), key: '', value: '', enabled: true, kind: 'text' }])}>添加表单项</button>
    {error && <p role="alert" className="danger-text">{error}</p>}
  </fieldset>;
}
