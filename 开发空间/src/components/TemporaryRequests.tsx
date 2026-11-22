import type { CSSProperties } from 'react';
import { Plus, Send, Zap } from 'lucide-react';
import type { TemporaryRequestsModel } from '../hooks/useTemporaryRequests';
import type { Preferences } from '../hooks/usePreferences';
import { DEFAULT_PREFERENCES } from '../lib/preferences';
import { TemporaryRequestEditor } from './RequestEditor';
import { ResponsePanel } from './ResponsePanel';
import { ResizeHandle } from './ResizeHandle';

type Props = {
  model: TemporaryRequestsModel;
  preferences: Preferences;
  updatePreferences: (patch: Partial<Preferences>) => void;
};

export function TemporaryRequests({ model, preferences, updatePreferences }: Props) {
  return <>
    <div className="temporary-heading">
      <span><Zap size={15} aria-hidden="true" /><strong>临时请求</strong><small>完整 URL，直接调试</small></span>
      <span className="temporary-badge">无环境 · 仅内存</span>
    </div>
    <div className="request-tabs temporary-tabs">
      <div role="tablist" aria-label="临时接口标签">
        {model.tabs.map((tab, index) => <div className={`request-tab ${tab.request.id === model.selectedId ? 'active' : ''}`} key={tab.request.id}>
          <button role="tab" aria-selected={tab.request.id === model.selectedId}
            tabIndex={tab.request.id === model.selectedId ? 0 : -1}
            aria-label={`切换到 ${tab.request.name}`} onClick={() => model.select(tab.request.id)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? model.tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + model.tabs.length) % model.tabs.length;
              model.select(model.tabs[next].request.id);
              event.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
            }}>
            <span className={`method method-${tab.request.method}`}>{tab.request.method}</span>
            <span className="ellipsis">{tab.request.name}</span>
            {tab.execution?.running && <span className="status-dot" title="请求中" />}
          </button>
          <button className="tab-close" aria-label={`关闭标签 ${tab.request.name}`} title="关闭临时请求" onClick={() => model.close(tab.request.id)}>×</button>
        </div>)}
      </div>
      <div className="request-tab-actions">
        <button className="close-all-tabs" aria-label="新建临时请求" onClick={() => model.open()}><Plus size={13} />新建</button>
        <button className="close-all-tabs" aria-label="关闭全部临时标签" disabled={!model.tabs.length} onClick={model.closeAll}>关闭全部</button>
      </div>
    </div>
    {model.request ? <TemporaryRequestView key={model.request.id} model={model} preferences={preferences} updatePreferences={updatePreferences} />
      : <div className="temporary-empty">
        <div className="empty-icon"><Send size={26} /></div>
        <h2>有地址，就能调试</h2>
        <p>无需项目、服务和环境。新建请求，填写完整 HTTP/HTTPS 地址即可开始。</p>
        <button className="primary" aria-label="开始临时请求" onClick={() => model.open()}><Plus size={15} />新建临时请求</button>
      </div>}
  </>;
}

function TemporaryRequestView({ model, preferences, updatePreferences }: Props) {
  const { layout, editorWidth, editorHeight } = preferences;
  const sideBySide = layout === 'side-by-side';
  return <div className={`request-split ${sideBySide ? 'split-columns' : 'split-rows'}`}
    style={{ '--editor-height': `${editorHeight}px`, '--editor-width': `${editorWidth}px` } as CSSProperties}>
    <div className="request-pane"><TemporaryRequestEditor model={model} /></div>
    <ResizeHandle label={sideBySide ? '请求面板宽度' : '请求面板高度'} orientation={sideBySide ? 'vertical' : 'horizontal'}
      value={sideBySide ? editorWidth : editorHeight} min={sideBySide ? 300 : 160} max={sideBySide ? 900 : 720}
      onChange={value => updatePreferences(sideBySide ? { editorWidth: value } : { editorHeight: value })}
      onReset={() => updatePreferences(sideBySide ? { editorWidth: DEFAULT_PREFERENCES.editorWidth } : { editorHeight: DEFAULT_PREFERENCES.editorHeight })} />
    <ResponsePanel key={model.execution?.id ?? 'empty'} execution={model.execution} onClear={model.clearResponse}
      baseline={model.baseline} onSaveBaseline={model.saveBaseline} onClearBaseline={model.clearBaseline} temporary />
  </div>;
}
