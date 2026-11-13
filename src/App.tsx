import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Braces, ChevronRight, Columns2, Command, Database, FileJson2, FlaskConical, History, LayoutGrid, Layers3, PanelLeftClose, PanelLeftOpen, Rows2, Save, Settings, Settings2, ShieldCheck, Wrench, X, Zap } from 'lucide-react';
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
import { useResponseBaselines } from './hooks/useResponseBaselines';
import { useTemporaryRequests } from './hooks/useTemporaryRequests';
import { TemporaryRequests } from './components/TemporaryRequests';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { COMMANDS, COMMAND_PALETTE_SHORTCUT, type CommandDefinition } from './lib/commands';
import { DEFAULT_PREFERENCES } from './lib/preferences';

const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
const JsonToolsDialog = lazy(() => import('./components/JsonToolsDialog'));
const DevToolsDialog = lazy(() => import('./components/DevToolsDialog'));
const RequestHistoryDialog = lazy(() => import('./components/RequestHistoryDialog'));

type Page = 'home' | 'requests' | 'temporary' | 'environments' | 'variables' | 'manage';
export default function App() {
  const model = useWorkbench();
  const temporary = useTemporaryRequests();
  const [page, setPage] = useState<Page>('requests');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jsonToolsOpen, setJsonToolsOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const commandFocus = useRef<HTMLElement | null>(null);
  const devToolsButton = useRef<HTMLButtonElement>(null);
  const closeDevTools = () => {
    setDevToolsOpen(false);
    requestAnimationFrame(() => devToolsButton.current?.focus());
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const closeHistory = () => {
    setHistoryOpen(false);
    requestAnimationFrame(() => historyButton.current?.focus());
  };
  const [creation, setCreation] = useState<EntityEditTarget | null>(null);
  const { preferences, updatePreferences } = usePreferences();
  const { baseline, saveBaseline, clearBaseline } = useResponseBaselines(JSON.stringify([model.request?.id, model.environment?.id]));
  const { sidebarCollapsed, sidebarWidth, editorHeight, editorWidth, layout } = preferences;
  const sideBySide = layout === 'side-by-side';
  const isTemporary = page === 'temporary';
  const openTemporary = () => {
    if (!temporary.tabs.length) temporary.open();
    setPage('temporary');
  };
  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    requestAnimationFrame(() => commandFocus.current?.focus());
  };
  const openCommandPalette = () => {
    if (document.querySelector('dialog[open]') || model.confirmation) return;
    commandFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandPaletteOpen(true);
  };
  useNativeClose({
    desktop, dirty: model.dirty, running: model.hasRunning || temporary.hasRunning, busy: model.busy,
    dialogOpen: !!model.confirmation, confirm: model.confirm, onError: model.setNotice,
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isEditorTarget = !!target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor');
      const dialogOpen = !!document.querySelector('dialog[open]');
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !dialogOpen && !model.confirmation) openCommandPalette();
        return;
      }
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        if (!dialogOpen && !model.confirmation && !isTemporary && !event.repeat && !event.isComposing && !model.busy && !model.loading && desktop) void model.save();
        return;
      }
      if (modifier && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!dialogOpen && !model.confirmation && !event.repeat) {
          if (isTemporary) void temporary.execute();
          else if (page === 'requests') void model.execute();
        }
        return;
      }
      if (dialogOpen || model.confirmation) return;
      if (modifier && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !isEditorTarget && !model.busy && !model.loading) void model.restoreClosedTab().then(restored => { if (restored) setPage('requests'); });
        return;
      }
      if (modifier && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !isEditorTarget && page === 'requests' && model.selectedId && !model.busy && !model.loading) void model.closeTab(model.selectedId);
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [model, temporary, isTemporary, page]);
  const nav = [
    { page: 'requests' as const, label: '接口工作台', Icon: Layers3 },
    { page: 'temporary' as const, label: '临时请求', Icon: Zap },
    { page: 'environments' as const, label: '环境矩阵', Icon: LayoutGrid },
    { page: 'variables' as const, label: '变量配置', Icon: Braces },
    { page: 'manage' as const, label: '工作区管理', Icon: Settings2 },
  ];
  const hasProjects = model.workspace.projects.length > 0;
  const openRequest = (id: string) => { model.selectRequest(id); setPage('requests'); };
  const executeCommand = (command: CommandDefinition) => {
    switch (command.id) {
      case 'save': void model.save(); break;
      case 'restore-closed-tab': void model.restoreClosedTab().then(restored => { if (restored) setPage('requests'); }); break;
      case 'open-temporary': openTemporary(); break;
      case 'open-json-tools': setJsonToolsOpen(true); break;
      case 'open-dev-tools': setDevToolsOpen(true); break;
      case 'open-history': setHistoryOpen(true); break;
      case 'open-settings': setSettingsOpen(true); break;
      case 'toggle-layout': updatePreferences({ layout: sideBySide ? 'stacked' : 'side-by-side' }); break;
      case 'toggle-sidebar': if (!isTemporary) updatePreferences({ sidebarCollapsed: !sidebarCollapsed }); break;
      case 'open-shortcuts': setShortcutsOpen(true); break;
    }
  };
  const disabledCommands = new Set<string>();
  if (isTemporary || !desktop || model.busy || model.loading) disabledCommands.add('save');
  if (!model.canRestoreClosedTab || model.busy || model.loading) disabledCommands.add('restore-closed-tab');
  if (isTemporary) disabledCommands.add('toggle-sidebar');
  return <div className="app-shell">
    <nav className="rail" aria-label="主导航"><button className="brand-mark" aria-label="返回主页" title="主页 · 项目仪表盘" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}><img src="/envdock.svg" alt="EnvDock" width={34} height={34} /></button><div className="rail-nav">{nav.map(({ page: target, label, Icon }) => <button className={`rail-button ${page === target ? 'active' : ''}`} data-page={target} aria-label={label} title={label} aria-current={page === target ? 'page' : undefined} onClick={() => target === 'temporary' ? openTemporary() : setPage(target)} key={target}><Icon size={20} /></button>)}<button className="rail-button" ref={historyButton} aria-label="请求时间线" title="请求时间线 · 查看、对比、恢复与排查包" aria-haspopup="dialog" aria-expanded={historyOpen} onClick={() => setHistoryOpen(true)}><History size={20} /></button><button className="rail-button" aria-label="JSON 工具" title="JSON 工具 · 临时格式化与搜索" aria-haspopup="dialog" aria-expanded={jsonToolsOpen} onClick={() => setJsonToolsOpen(true)}><FileJson2 size={20} /></button><button className="rail-button" ref={devToolsButton} aria-label="临时开发工具箱" title="临时开发工具箱 · URL、Base64、时间戳、JWT" aria-haspopup="dialog" aria-expanded={devToolsOpen} onClick={() => setDevToolsOpen(true)}><Wrench size={20} /></button></div><div className="rail-settings"><button className="rail-button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button><span title="原生执行 · 本地数据"><ShieldCheck size={16} /></span></div></nav>
    <div className="app-main">
      <header className="topbar">
        <div className="project-select" hidden={isTemporary}><span className="field-caption">项目</span><ColorSelect label="当前项目" value={model.project?.id ?? ''} options={model.workspace.projects.map(p => ({ value: p.id, label: p.name, color: p.color }))} onChange={model.selectProject} disabled={model.busy || model.loading} placeholder={hasProjects ? '请选择项目' : '尚未创建项目'} fallbackColor={PROJECT_COLOR} /></div>
        <div className="environment-select" hidden={isTemporary}><ColorSelect key={model.project?.id ?? 'none'} label="当前环境" value={model.environment?.id ?? ''} options={[{ value: '', label: '请选择环境' }, ...model.workspace.environments.filter(e => e.projectId === model.project?.id).map(e => ({ value: e.id, label: e.name, color: e.color, isProduction: e.isProduction }))]} onChange={model.selectEnvironment} disabled={!model.project || model.busy || model.loading} fallbackColor={ENVIRONMENT_COLOR} /></div>
        {isTemporary && <span className="temporary-context">临时调试 · 无需配置环境</span>}
        <div className="topbar-actions"><div className="layout-tools"><button className="icon-button" hidden={isTemporary} aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!sidebarCollapsed} onClick={() => updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><button className="icon-button" aria-label={sideBySide ? '上下分屏' : '左右分屏'} title={sideBySide ? '切换为上下分屏' : '切换为左右分屏'} onClick={() => updatePreferences({ layout: sideBySide ? 'stacked' : 'side-by-side' })}>{sideBySide ? <Rows2 size={17} /> : <Columns2 size={17} />}</button><button className="icon-button" aria-label="打开命令面板" title={`命令面板 · ${COMMAND_PALETTE_SHORTCUT.map(key => key === 'Mod' ? 'Ctrl/Cmd' : key).join(' ')}`} onClick={openCommandPalette}><Command size={17} /></button></div><span className={`save-state ${!isTemporary && model.dirty ? 'unsaved' : ''}`}>{isTemporary ? '临时会话' : model.busy ? '处理中…' : model.dirty ? '未保存修改' : desktop ? '已保存' : '内存会话'}</span>{!isTemporary && <button className="icon-button" aria-label="保存全部修改" title="保存全部修改 · Ctrl/Cmd+S" disabled={!desktop || model.busy || model.loading} onClick={() => void model.save()}><Save size={17} /></button>}</div>
      </header>
      {!desktop && <div className="preview-banner"><FlaskConical size={14} /><span>仅内存预览，桌面版才可保存和发送</span><span className="preview-banner-detail">刷新后数据清空 · 不连接网络</span></div>}
      <div className="workspace-layout" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        <div className="sidebar-container" hidden={sidebarCollapsed || isTemporary}><Sidebar workspace={model.workspace} selectedId={model.selectedId} onSelect={openRequest} onManage={() => setPage('manage')} onCreate={setCreation} disabled={model.busy || model.loading} /></div>
        {!sidebarCollapsed && !isTemporary && <ResizeHandle label="侧栏宽度" orientation="vertical" value={sidebarWidth} min={200} max={420} onChange={value => updatePreferences({ sidebarWidth: value })} onReset={() => updatePreferences({ sidebarWidth: DEFAULT_PREFERENCES.sidebarWidth })} disabled={model.busy} />}
        <main className="main-content" aria-busy={!isTemporary && (model.busy || model.loading)}>
          {model.loading && !isTemporary ? <div className="empty-state"><Database size={32} /><h2>正在加载本地工作区</h2></div> : <fieldset className={`workbench-content ${page === 'requests' || isTemporary ? 'request-workspace' : ''}`} disabled={model.busy && !isTemporary}>
            {page === 'home' && <Dashboard model={model} onNavigate={setPage} onOpenRequest={openRequest} onCreate={setCreation} />}
            {isTemporary && <TemporaryRequests model={temporary} preferences={preferences} updatePreferences={updatePreferences} />}
            {page === 'requests' && <RequestTabs model={model} />}
            {page === 'requests' && (model.request ? <div className={`request-split ${sideBySide ? "split-columns" : "split-rows"}`} style={{ "--editor-height": `${editorHeight}px`, "--editor-width": `${editorWidth}px` } as CSSProperties}><div className="request-pane"><RequestEditor key={JSON.stringify([model.request.id, model.environment?.id])} model={model} onConfigureAddresses={() => setPage('environments')} onTemporaryRequest={openTemporary} /></div><ResizeHandle label={sideBySide ? "请求面板宽度" : "请求面板高度"} orientation={sideBySide ? "vertical" : "horizontal"} value={sideBySide ? editorWidth : editorHeight} min={sideBySide ? 300 : 160} max={sideBySide ? 900 : 720} onChange={value => updatePreferences(sideBySide ? { editorWidth: value } : { editorHeight: value })} onReset={() => updatePreferences(sideBySide ? { editorWidth: DEFAULT_PREFERENCES.editorWidth } : { editorHeight: DEFAULT_PREFERENCES.editorHeight })} disabled={model.busy} /><ResponsePanel key={JSON.stringify([model.request.id, model.environment?.id, model.execution?.id])} execution={model.execution} onClear={() => void model.clearResponse()} baseline={baseline} onSaveBaseline={saveBaseline} onClearBaseline={clearBaseline} /></div> : <div className="welcome-panel"><div className="eyebrow">YOUR LOCAL API WORKSPACE</div><div className="welcome-symbol"><Command size={37} /></div><h1>让接口调试，<br /><span>更专注一些。</span></h1><p>项目、环境与服务，一处有序管理。<br />从左侧选择接口，或创建你的第一个工作区。</p><div className="welcome-actions"><button className="primary" onClick={() => setPage('manage')}>{hasProjects ? '管理接口集合' : '创建第一个项目'}<ChevronRight size={15} /></button><button onClick={openTemporary}><Zap size={15} />临时调试</button>{!desktop && !hasProjects && <button onClick={model.loadDemo}>载入内存示例</button>}</div><div className="getting-started"><div><span>01</span><strong>建立项目与服务</strong><small>让接口按业务归档</small></div><div><span>02</span><strong>配置环境地址</strong><small>开发与生产清晰区分</small></div><div><span>03</span><strong>编辑并发送请求</strong><small>在桌面端完成原生调试</small></div></div></div>)}
            {page === 'environments' && <EnvironmentMatrix model={model} onManage={() => setPage('manage')} />}
            {page === 'variables' && <div className="page-panel"><div className="page-heading"><div><div className="eyebrow">VARIABLES</div><h1>配置一次，在合适的范围生效</h1><p>项目 / 服务 / 环境 / 绑定 / 接口 / 本次临时。服务与接口层跟随左侧当前选中接口。</p></div></div><VariablesEditor model={model} onConfigureAddresses={() => setPage('environments')} /></div>}
            {page === 'manage' && <EntityManager model={model} />}
          </fieldset>}
        </main>
      </div>
      <footer className="statusbar"><span><span className="status-dot" />{desktop ? '桌面模式 · SQLite 工作区' : '浏览器预览 · 仅内存'}</span><span>{model.workspace.requests.length} 个接口<span className="footer-divider">/</span>revision {model.workspace.revision}</span><span className="statusbar-right">环境：{isTemporary ? '无需环境' : model.environment?.name ?? '未选择'}<span className="footer-divider">·</span>UTF-8</span><span className="author-credit">著作:lxs</span></footer>
    </div>
    {model.notice && <div className="toast" role="status"><span>{model.notice}</span><button className="icon-button" aria-label="关闭通知" onClick={() => model.setNotice('')}><X size={15} /></button>{desktop && !hasProjects && <button onClick={() => void model.load()}>重新加载</button>}</div>}
    {isTemporary && temporary.notice && <div className="toast" role="status"><span>{temporary.notice}</span><button className="icon-button" aria-label="关闭临时通知" onClick={() => temporary.setNotice('')}><X size={15} /></button></div>}
    {settingsOpen && <Suspense fallback={null}><SettingsPanel model={model} preferences={preferences} updatePreferences={updatePreferences} onClose={() => setSettingsOpen(false)} /></Suspense>}
    {jsonToolsOpen && <Suspense fallback={null}><JsonToolsDialog onClose={() => setJsonToolsOpen(false)} /></Suspense>}
    {devToolsOpen && <Suspense fallback={null}><DevToolsDialog onClose={closeDevTools}
      onOpenJson={() => { setDevToolsOpen(false); setJsonToolsOpen(true); }} /></Suspense>}
    {historyOpen && <Suspense fallback={null}><RequestHistoryDialog key={model.project?.id ?? 'none'}
      entries={model.history.filter(entry => entry.projectId === model.project?.id)} projectName={model.project?.name}
      busy={model.busy} onClose={closeHistory}
      onRestore={async id => { const restored = await model.restoreHistory(id); if (restored) setPage('requests'); return restored; }}
      onDelete={model.deleteHistory} onClear={() => model.clearHistory(model.project?.id)} /></Suspense>}
    {commandPaletteOpen && <CommandPalette commands={COMMANDS} disabled={disabledCommands} onExecute={executeCommand} onClose={closeCommandPalette} />}
    {shortcutsOpen && <ShortcutsDialog commands={COMMANDS} onClose={() => setShortcutsOpen(false)} />}
    {creation && <EntityEditor model={model} target={creation} onClose={() => setCreation(null)} />}
    {model.confirmation && <ConfirmDialog value={model.confirmation} close={() => model.setConfirmation(null)} />}
  </div>;
}
