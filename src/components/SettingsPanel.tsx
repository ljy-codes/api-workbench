import { useState } from 'react';
import { ArrowDownUp, Columns2, Database, Download, Monitor, Moon, Palette, PanelLeft, Rows2, Sun } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { Preferences } from '../lib/preferences';
import { Dialog } from './Dialog';
import { ExchangePanel } from './ExchangePanel';
import { DataCleanup } from './DataCleanup';

type Section = 'appearance' | 'layout' | 'exchange' | 'data';
export default function SettingsPanel({ model, preferences, updatePreferences, onClose }: {
  model: Workbench; preferences: Preferences; updatePreferences: (patch: Partial<Preferences>) => void; onClose: () => void;
}) {
  const [section, setSection] = useState<Section>('appearance');
  const sections = [
    { id: 'appearance' as const, name: '外观', Icon: Palette },
    { id: 'layout' as const, name: '布局', Icon: PanelLeft },
    { id: 'exchange' as const, name: '导入导出', Icon: ArrowDownUp },
    { id: 'data' as const, name: '本地数据', Icon: Database },
  ];
  return <Dialog title="设置" wide onClose={onClose}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">{sections.map(({ id, name, Icon }) =>
        <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={16} />{name}</button>,
      )}<span className="settings-local">LOCAL FIRST<br />所有设置仅保存在本机</span></nav>
      <div className="settings-content">
        {section === 'appearance' && <section aria-label="外观设置">
          <div className="eyebrow">APPEARANCE</div><h3>适合你的工作光线</h3><p className="hint">立即生效，下次启动沿用。</p>
          <div className="theme-options">{([
            { id: 'light', name: '浅色', Icon: Sun }, { id: 'dark', name: '深色', Icon: Moon }, { id: 'system', name: '跟随系统', Icon: Monitor },
          ] as const).map(({ id, name, Icon }) => <button key={id} className={`theme-option theme-${id}`} aria-pressed={preferences.theme === id} onClick={() => updatePreferences({ theme: id })}>
            <span className="theme-thumbnail" aria-hidden="true"><i /><b><em /><em /><em /></b></span><span><Icon size={15} />{name}</span>
          </button>)}</div>
          <div className="settings-note"><Palette size={18} /><span>项目和环境颜色可在「工作区管理」中分别配置。编辑器的键、字符串和数值保持独立配色。</span></div>
        </section>}
        {section === 'layout' && <section aria-label="布局设置">
          <div className="eyebrow">LAYOUT</div><h3>把空间留给调试</h3><p className="hint">也可通过主界面右上角快速切换，拖动分隔线调整尺寸。</p>
          <div className="settings-choice-row"><button aria-pressed={preferences.layout === 'stacked'} onClick={() => updatePreferences({ layout: 'stacked' })}><Rows2 size={18} />上下分屏</button><button aria-pressed={preferences.layout === 'side-by-side'} onClick={() => updatePreferences({ layout: 'side-by-side' })}><Columns2 size={18} />左右分屏</button></div>
          <label className="settings-toggle"><span>显示接口侧栏<small>收起后，编辑区占用完整宽度</small></span><input type="checkbox" checked={!preferences.sidebarCollapsed} onChange={e => updatePreferences({ sidebarCollapsed: !e.target.checked })} /></label>
          <button className="text-button" onClick={() => updatePreferences({ sidebarWidth: 240, editorHeight: 280, editorWidth: 500, sidebarCollapsed: false, layout: 'stacked' })}>恢复默认布局</button>
        </section>}
        {section === 'exchange' && <ExchangePanel model={model} />}
        {section === 'data' && <section aria-label="本地存储设置"><div className="eyebrow">LOCAL STORAGE</div><h3>数据留在你的设备</h3><p className="hint">无需账号或云端同步。备份包含已保存的本机工作区。</p><button disabled={model.busy || model.loading} onClick={() => void model.backup()}><Download size={15} />备份已保存工作区</button><DataCleanup model={model} /></section>}
      </div>
    </div>
  </Dialog>;
}
