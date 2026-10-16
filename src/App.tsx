import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { version } from '../package.json';
import { Braces, ChevronRight, Columns2, Command, Database, FlaskConical, Globe2, Layers3, PanelLeftClose, PanelLeftOpen, Rows2, Save, Settings, Settings2, ShieldCheck, X } from 'lucide-react';
import { useWorkbench } from './hooks/useWorkbench';
import { useNativeClose } from './hooks/useNativeClose';
import { desktop } from './lib/ipc';
import { ConfirmDialog } from './components/Dialog';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponsePanel } from './components/ResponsePanel';
import { EnvironmentMatrix } from './components/EnvironmentMatrix';
import { EntityManager } from './components/EntityManager';
import { EntityEditor, type EntityEditTarget } from './components/EntityEditor';
import { ColorSelect } from './components/ColorSelect';
import { ENVIRONMENT_COLOR, PROJECT_COLOR } from './components/ColorPicker';
import { VariablesEditor } from './components/VariablesEditor';
import { Dashboard } from './components/Dashboard';

import { ResizeHandle } from './components/ResizeHandle';
import { RequestTabs } from './components/RequestTabs';
import { usePreferences } from './hooks/usePreferences';

const SettingsPanel = lazy(() => import('./components/SettingsPanel'));

type Page = 'home' | 'requests' | 'environments' | 'variables' | 'manage';
export default function App() {
  const model = useWorkbench();
  const [page, setPage] = useState<Page>('requests');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creation, setCreation] = useState<EntityEditTarget | null>(null);
  const { preferences, updatePreferences } = usePreferences();
  const { sidebarCollapsed, sidebarWidth, editorHeight, editorWidth, layout } = preferences;
  const sideBySide = layout === 'side-by-side';
  useNativeClose({
    desktop, dirty: model.dirty, running: model.hasRunning, busy: model.busy,
    dialogOpen: !!model.confirmation, confirm: model.confirm, onError: model.setNotice,
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !event.isComposing && !document.querySelector('dialog[open]') && !model.confirmation && !model.busy && !model.loading && desktop) void model.save();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !document.querySelector('dialog[open]') && page === 'requests') void model.execute();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [model, page]);
  const nav = [
    { page: 'requests' as const, label: '接口工作台', Icon: Layers3 },
    { page: 'environments' as const, label: '环境矩阵', Icon: Globe2 },
    { page: 'variables' as const, label: '变量配置', Icon: Braces },
    { page: 'manage' as const, label: '工作区管理', Icon: Settings2 },
  ];
  const hasProjects = model.workspace.projects.length > 0;
  const openRequest = (id: string) => { model.selectRequest(id); setPage('requests'); };
  return <div className="app-shell">
    <nav className="rail" aria-label="主导航"><button className="brand-mark" aria-label="返回主页" title="主页 · 项目仪表盘" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}><img src="/envdock.svg" alt="EnvDock" width={34} height={34} /></button><div className="rail-nav">{nav.map(({ page: target, label, Icon }) => <button className={`rail-button ${page === target ? 'active' : ''}`} aria-label={label} title={label} aria-current={page === target ? 'page' : undefined} onClick={() => setPage(target)} key={target}><Icon size={20} /></button>)}</div><div className="rail-settings"><button className="rail-button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button><span title="原生执行 · 本地数据"><ShieldCheck size={16} /></span></div></nav>
    <div className="app-main">
      <header className="topbar">
        <div className="brand-title">EnvDock<span className="version-label">{version}</span></div><span className="topbar-divider" />
        <div className="project-select"><span className="field-caption">项目</span><ColorSelect label="当前项目" value={model.project?.id ?? ''} options={model.workspace.projects.map(p => ({ value: p.id, label: p.name, color: p.color }))} onChange={model.selectProject} disabled={model.busy || model.loading} placeholder={hasProjects ? '请选择项目' : '尚未创建项目'} fallbackColor={PROJECT_COLOR} /></div>
        <div className="environment-select"><ColorSelect key={model.project?.id ?? 'none'} label="当前环境" value={model.environment?.id ?? ''} options={[{ value: '', label: '请选择环境' }, ...model.workspace.environments.filter(e => e.projectId === model.project?.id).map(e => ({ value: e.id, label: e.name, color: e.color, isProduction: e.isProduction }))]} onChange={model.selectEnvironment} disabled={!model.project || model.busy || model.loading} fallbackColor={ENVIRONMENT_COLOR} /></div>
        <div className="topbar-actions"><div className="layout-tools"><button className="icon-button" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} onClick={() => updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><button className="icon-button" aria-label={sideBySide ? '上下分屏' : '左右分屏'} title={sideBySide ? '切换为上下分屏' : '切换为左右分屏'} onClick={() => updatePreferences({ layout: sideBySide ? 'stacked' : 'side-by-side' })}>{sideBySide ? <Rows2 size={17} /> : <Columns2 size={17} />}</button></div><span className={`save-state ${model.dirty ? 'unsaved' : ''}`}>{model.busy ? '处理中…' : model.dirty ? '未保存修改' : desktop ? '已保存' : '内存会话'}</span><button className="icon-button" aria-label="保存全部修改" title="保存全部修改 · Ctrl/Cmd+S" disabled={!desktop || model.busy || model.loading} onClick={() => void model.save()}><Save size={17} /></button></div>
      </header>
      {!desktop && <div className="preview-banner"><FlaskConical size={14} /><span>仅内存预览，桌面版才可保存和发送</span><span className="preview-banner-detail">刷新后数据清空 · 不连接网络</span></div>}
      <div className="workspace-layout" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        <div className="sidebar-container" hidden={sidebarCollapsed}><Sidebar workspace={model.workspace} selectedId={model.selectedId} onSelect={openRequest} onManage={() => setPage('manage')} onCreate={setCreation} disabled={model.busy || model.loading} /></div>
        {!sidebarCollapsed && <ResizeHandle label="侧栏宽度" orientation="vertical" value={sidebarWidth} min={200} max={420} onChange={value => updatePreferences({ sidebarWidth: value })} disabled={model.busy} />}
        <main className="main-content" aria-busy={model.busy || model.loading}>
          {model.loading ? <div className="empty-state"><Database size={32} /><h2>正在加载本地工作区</h2></div> : <fieldset className={`workbench-content ${page === 'requests' ? 'request-workspace' : ''}`} disabled={model.busy}>
            {page === 'home' && <Dashboard model={model} onNavigate={setPage} onOpenRequest={openRequest} onCreate={setCreation} />}
            {page === 'requests' && <RequestTabs model={model} />}
            {page === 'requests' && (model.request ? <div className={`request-split ${sideBySide ? "split-columns" : "split-rows"}`} style={{ "--editor-height": `${editorHeight}px`, "--editor-width": `${editorWidth}px` } as CSSProperties}><div className="request-pane"><RequestEditor key={JSON.stringify([model.request.id, model.environment?.id])} model={model} onConfigureAddresses={() => setPage('environments')} /></div><ResizeHandle label={sideBySide ? "请求面板宽度" : "请求面板高度"} orientation={sideBySide ? "vertical" : "horizontal"} value={sideBySide ? editorWidth : editorHeight} min={sideBySide ? 300 : 160} max={sideBySide ? 900 : 720} onChange={value => updatePreferences(sideBySide ? { editorWidth: value } : { editorHeight: value })} disabled={model.busy} /><ResponsePanel key={JSON.stringify([model.request.id, model.environment?.id, model.execution?.id])} execution={model.execution} onClear={() => void model.clearResponse()} /></div> : <div className="welcome-panel"><div className="eyebrow">YOUR LOCAL API WORKSPACE</div><div className="welcome-symbol"><Command size={37} /></div><h1>让接口调试，<br /><span>更专注一些。</span></h1><p>项目、环境与服务，一处有序管理。<br />从左侧选择接口，或创建你的第一个工作区。</p><div className="welcome-actions"><button className="primary" onClick={() => setPage('manage')}>{hasProjects ? '管理接口集合' : '创建第一个项目'}<ChevronRight size={15} /></button>{!desktop && !hasProjects && <button onClick={model.loadDemo}>载入内存示例</button>}</div><div className="getting-started"><div><span>01</span><strong>建立项目与服务</strong><small>让接口按业务归档</small></div><div><span>02</span><strong>配置环境地址</strong><small>开发与生产清晰区分</small></div><div><span>03</span><strong>编辑并发送请求</strong><small>在桌面端完成原生调试</small></div></div></div>)}
            {page === 'environments' && <EnvironmentMatrix model={model} onManage={() => setPage('manage')} />}
            {page === 'variables' && <div className="page-panel"><div className="page-heading"><div><div className="eyebrow">VARIABLES</div><h1>配置一次，在合适的范围生效</h1><p>项目 / 服务 / 环境 / 绑定 / 接口 / 本次临时。服务与接口层跟随左侧当前选中接口。</p></div></div><VariablesEditor model={model} onConfigureAddresses={() => setPage('environments')} /></div>}
            {page === 'manage' && <EntityManager model={model} />}
          </fieldset>}
        </main>
      </div>
      <footer className="statusbar"><span><span className="status-dot" />{desktop ? '桌面模式 · SQLite 工作区' : '浏览器预览 · 仅内存'}</span><span>{model.workspace.requests.length} 个接口<span className="footer-divider">/</span>revision {model.workspace.revision}</span><span className="statusbar-right">环境：{model.environment?.name ?? '未选择'}<span className="footer-divider">·</span>UTF-8</span><span className="author-credit">著作:lxs</span></footer>
    </div>
    {model.notice && <div className="toast" role="status"><span>{model.notice}</span><button className="icon-button" aria-label="关闭通知" onClick={() => model.setNotice('')}><X size={15} /></button>{desktop && !hasProjects && <button onClick={() => void model.load()}>重新加载</button>}</div>}
    {settingsOpen && <Suspense fallback={null}><SettingsPanel model={model} preferences={preferences} updatePreferences={updatePreferences} onClose={() => setSettingsOpen(false)} /></Suspense>}
    {creation && <EntityEditor model={model} target={creation} onClose={() => setCreation(null)} />}
    {model.confirmation && <ConfirmDialog value={model.confirmation} close={() => model.setConfirmation(null)} />}
  </div>;
}
