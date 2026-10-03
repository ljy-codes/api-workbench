import { useState } from 'react';
import type { AuthConfig } from '../types';

function isReference(value: string) {
  if (value === '') return true;
  if (!value.startsWith('{{') || !value.endsWith('}}')) return false;
  const name = value.slice(2, -2);
  // Match Rust's nonempty trimmed name and char::is_control checks. Whitespace
  // around (or within) a variable name is not itself an invalid credential.
  return !/^\p{White_Space}*$/u.test(name) && !/[{}\u0000-\u001f\u007f-\u009f]/.test(name);
}

// Invalid keystrokes stay local to the field and never enter a saveable workspace.
function SecretReference({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [state, setState] = useState({ source: value, draft: value, recoverable: null as string | null });
  let field = state;
  if (state.source !== value) {
    // Synchronize before committing stale DOM, but not on unrelated rerenders
    // or new auth object identities. Keep interrupted invalid input recoverable.
    field = { source: value, draft: value, recoverable: isReference(state.draft) ? state.recoverable : state.draft };
    setState(field);
  }
  const valid = isReference(field.draft);
  return <div><label>{label}<input aria-label={label} autoComplete="off" spellCheck={false} value={field.draft} aria-invalid={!valid} placeholder="{{秘密变量名}}" onChange={e => {
    const next = e.target.value;
    const accepted = isReference(next);
    setState({ ...field, draft: next, recoverable: accepted ? null : field.recoverable });
    if (accepted) onChange(next);
  }} />{!valid && <small role="alert" className="danger-text">仅允许空值或完整变量引用；当前输入不会保存或发送。</small>}</label>
    {field.recoverable !== null && <div className="hint">引用已由外部更新，未完成输入仅在当前编辑器内保留。
      <button type="button" className="text-button" onClick={() => setState({ ...field, draft: field.recoverable!, recoverable: null })}>恢复未完成输入</button>
    </div>}
  </div>;
}

export function AuthEditor({ value, onChange, inherited = false }: { value?: AuthConfig | null; onChange: (value: AuthConfig | null) => void; inherited?: boolean }) {
  const kind = value?.kind ?? (inherited ? 'inherit' : 'none');
  const update = (patch: Partial<AuthConfig>) => onChange({ ...value!, ...patch });
  return <div className="auth-editor">
    <p className="hint">凭据只允许使用 <code>{'{{变量名}}'}</code> 引用。在变量配置中将实际值标记为秘密后保存；鉴权生成项与手工 Header / Query 冲突时会拒绝发送。</p>
    <label>鉴权方式<select aria-label="鉴权方式" value={kind} onChange={e => {
      const next = e.target.value;
      onChange(next === 'inherit' ? null : next === 'apiKey' ? { kind: 'apiKey', key: '', value: '', location: 'header' } : { kind: next as AuthConfig['kind'] });
    }}>{inherited && <option value="inherit">继承服务鉴权</option>}<option value="none">无鉴权{inherited ? '（不继承）' : ''}</option><option value="bearer">Bearer Token</option><option value="basic">Basic</option><option value="apiKey">API Key</option></select></label>
    {kind === 'inherit' && <p className="hint">使用所属服务的公共鉴权配置。</p>}
    <div className="auth-fields" key={kind}>
      {kind === 'bearer' && <SecretReference label="Token 变量引用" value={value?.token ?? ''} onChange={token => update({ token })} />}
      {kind === 'basic' && <><label>用户名<input aria-label="鉴权用户名" autoComplete="off" value={value?.username ?? ''} onChange={e => update({ username: e.target.value })} /></label><SecretReference label="密码变量引用" value={value?.password ?? ''} onChange={password => update({ password })} /></>}
      {kind === 'apiKey' && <><label>Key 名称<input aria-label="API Key 名称" value={value?.key ?? ''} onChange={e => update({ key: e.target.value })} /></label><SecretReference label="API Key 变量引用" value={value?.value ?? ''} onChange={secret => update({ value: secret })} /><label>位置<select aria-label="API Key 位置" value={value?.location ?? 'header'} onChange={e => update({ location: e.target.value as 'header' | 'query' })}><option value="header">Header</option><option value="query">Query</option></select></label></>}
    </div>
  </div>;
}
