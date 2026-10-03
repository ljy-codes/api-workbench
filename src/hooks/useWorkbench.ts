import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecuteInput, Pair, Preview, ResponseData, Workspace } from '../types';
import type { Confirmation } from '../components/Dialog';
import { api, desktop } from '../lib/ipc';
import { demoWorkspace, emptyWorkspace, errorMessage, responseForExecution, uid } from '../lib/workspace';

export type Execution = { id: string; requestId: string; environment: string; requestName: string; running: boolean; response?: ResponseData; error?: string; cancelRequested?: boolean };
export function useWorkbench() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [loading, setLoading] = useState(desktop);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [executions, setExecutions] = useState<Record<string, Execution>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [temporary, setTemporary] = useState<Record<string, Pair[]>>({});
  const lock = useRef(false);
  const running = useRef(new Set<string>());
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const confirm = useCallback((options: Omit<Confirmation, 'resolve'>) => new Promise<boolean>(resolve => setConfirmation({ ...options, resolve })), []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const w = await api.load();
      const first = w.requests.find(r => w.services.some(s => s.id === r.serviceId && s.projectId === w.activeProjectId))?.id ?? null;
      setWorkspace(w); setDirty(false); setSelectedId(first); setOpenTabs(first ? [first] : []);
    }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (desktop) void load(); }, [load]);
  useEffect(() => {
    if (desktop) return;
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const mutate = (change: (w: Workspace) => Workspace) => {
    if (lock.current) return;
    setWorkspace(w => change(w));
    setDirty(true); setPreview(null);
  };
  const saveSnapshot = async (w: Workspace) => {
    const saved = await api.save(w);
    setWorkspace(saved); wsRef.current = saved; setDirty(false);
    return saved;
  };
  const save = async () => {
    if (lock.current) return;
    if (!desktop) { setNotice('仅内存预览，桌面版才可保存和发送'); return; }
    lock.current = true; setBusy(true);
    try { await saveSnapshot(workspace); setNotice('工作区已保存'); }
    catch (e) { setNotice(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const switchContext = async (action: () => void) => {
    if (lock.current) return;
    if (dirty && !await confirm({ title: '有尚未保存的修改', message: '继续切换不会丢失草稿，修改仍保留在当前工作区中。请在退出前保存。', confirmLabel: '保留草稿并切换' })) return;
    action(); setPreview(null);
  };
  const project = workspace.projects.find(p => p.id === workspace.activeProjectId);
  const environment = workspace.environments.find(e => e.id === project?.activeEnvironmentId);
  const projectRequests = workspace.requests.filter(r => workspace.services.some(s => s.id === r.serviceId && s.projectId === project?.id));
  const request = projectRequests.find(r => r.id === selectedId);
  useEffect(() => {
    setOpenTabs(tabs => tabs.filter(id => workspace.requests.some(r => r.id === id)));
    if (selectedId && !request) { setSelectedId(null); setPreview(null); }
  }, [workspace.requests, selectedId, request]);
  const execute = async (previewOnly = false, exportOnly = false) => {
    if (lock.current || !request || !environment || (!previewOnly && !exportOnly && running.current.has(request.id))) return;
    if (!desktop) { setNotice('仅内存预览，桌面版才可保存和发送'); return; }
    lock.current = true; setBusy(true);
    // Capture identity before any asynchronous confirmation; environment changes cannot retarget it.
    const requestId = request.id;
    const environmentId = environment.id;
    const executionId = uid();
    let preparationReleased = false;
    try {
      if (dirty) {
        if (!await confirm({ title: '先保存配置', message: '原生执行使用已保存工作区。是否保存全部修改后继续？', confirmLabel: '保存并继续' })) return;
        await saveSnapshot(workspace);
      }
      const capturedRequest = wsRef.current.requests.find(r => r.id === requestId);
      if (!capturedRequest) throw new Error('接口已不存在');
      const input: ExecuteInput = { executionId, environmentId, request: structuredClone(capturedRequest), temporaryVariables: structuredClone(temporary[requestId] ?? []), productionConfirmed: false };
      if (exportOnly) {
        const curl = await api.exportCurl(input);
        try { await navigator.clipboard.writeText(curl); }
        catch { throw new Error('剪贴板写入失败；未复制 cURL，请重试。'); }
        setNotice('已复制脱敏 cURL；执行前请替换凭据和文件路径，并检查普通正文。');
        return;
      }
      const prepared = await api.preview(input);
      setPreview(prepared);
      if (previewOnly) return;
      if (prepared.isProduction) {
        if (!await confirm({ title: '确认发送到生产环境', message: `${capturedRequest.method} ${prepared.url}\n环境：${prepared.environmentName}。此操作可能修改真实数据，取消请求不代表回滚。`, confirmLabel: '确认生产发送', danger: true })) return;
        input.productionConfirmed = true;
      }
      running.current.add(requestId);
      setExecutions(prev => ({ ...prev, [requestId]: { id: executionId, requestId, environment: prepared.environmentName, requestName: capturedRequest.name, running: true } }));
      lock.current = false; setBusy(false);
      preparationReleased = true;
      try {
        const result = await api.send(input);
        const response = responseForExecution(executionId, result);
        if (!response) throw new Error('响应执行 ID 不匹配，已拒绝显示');
        setExecutions(prev => prev[requestId]?.id === executionId ? { ...prev, [requestId]: { ...prev[requestId], response, running: false } } : prev);
      } catch (error) {
        setExecutions(prev => prev[requestId]?.id === executionId ? { ...prev, [requestId]: { ...prev[requestId], error: errorMessage(error), running: false } } : prev);
      } finally { running.current.delete(requestId); }
    } catch (error) { setNotice(errorMessage(error)); }
    finally {
      // A completed network call must not release a different request's preparation lock.
      if (!preparationReleased) { lock.current = false; setBusy(false); }
    }
  };
  const cancel = async () => {
    const execution = selectedId ? executions[selectedId] : null;
    if (!execution?.running || execution.cancelRequested) return;
    try {
      await api.cancel(execution.id);
      setExecutions(prev => prev[execution.requestId]?.id === execution.id ? { ...prev, [execution.requestId]: { ...prev[execution.requestId], cancelRequested: true } } : prev);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  const closeTab = (id: string) => {
    if (lock.current || confirmation) return;
    const remaining = openTabs.filter(tab => tab !== id);
    setOpenTabs(remaining);
    if (selectedId === id) {
      setSelectedId([...remaining].reverse().find(tab => projectRequests.some(r => r.id === tab)) ?? null);
      setPreview(null);
    }
  };
  const runLocalAction = async (action: () => Promise<void>, nativeOnly = false) => {
    if (lock.current || confirmation) return false;
    if (nativeOnly && !desktop) { setNotice('此功能需要桌面模式；浏览器仅保留内存草稿。'); return false; }
    lock.current = true; setBusy(true);
    try { await action(); return true; }
    catch (error) { setNotice(errorMessage(error)); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const applyImport = (next: Workspace) => {
    const newRequest = next.requests.find(r => !wsRef.current.requests.some(old => old.id === r.id) && next.services.some(s => s.id === r.serviceId && s.projectId === next.activeProjectId));
    setWorkspace(next); wsRef.current = next; setDirty(true); setPreview(null);
    if (newRequest) { setSelectedId(newRequest.id); setOpenTabs(tabs => [...tabs, newRequest.id]); }
    else setSelectedId(null);
    setNotice('已导入为未保存草稿；请检查地址、秘密变量和文件项后保存。');
  };
  const importProjectText = (text: string) => runLocalAction(async () => {
    const { importProject } = await import('../lib/exchange');
    applyImport(importProject(wsRef.current, text));
  });
  const importCurlText = (text: string, serviceName?: string) => runLocalAction(async () => {
    const { importCurl } = await import('../lib/curl');
    applyImport(importCurl(wsRef.current, text, serviceName));
  });
  const readProject = () => runLocalAction(async () => {
    const text = await api.readProjectFile();
    if (text === null) return;
    const { importProject } = await import('../lib/exchange');
    applyImport(importProject(wsRef.current, text));
  }, true);
  const writeProject = () => runLocalAction(async () => {
    if (!project) return;
    if (!await confirm({ title: '导出前检查敏感内容', message: '导出当前项目草稿，不自动保存数据库。已知凭据会脱敏，文件路径会清空；普通正文、文本表单、自定义 Header 或变量仍可能包含秘密，请检查后再分享。', confirmLabel: '导出脱敏项目' })) return;
    const { exportProject } = await import('../lib/exchange');
    const path = await api.writeProjectFile(exportProject(wsRef.current, project.id));
    if (path) setNotice(`项目已导出：${path}`);
  }, true);
  const pickFile = async () => {
    let path: string | null = null;
    await runLocalAction(async () => { path = await api.pickFile(); }, true);
    return path;
  };
  const backup = () => runLocalAction(async () => {
    const path = await api.backup();
    setNotice(`已备份已保存数据（不含内存草稿）：${path}`);
  }, true);
  return {
    workspace, project, environment, request, selectedId, loading, busy, dirty, notice, setNotice,
    confirmation, setConfirmation, confirm, mutate, save, execute, cancel, preview, load,
    openTabs, closeTab, copyCurl: () => execute(false, true), importProjectText, importCurlText, readProject, writeProject, pickFile, backup,
    hasRunning: Object.values(executions).some(execution => execution.running),
    execution: selectedId ? executions[selectedId] : undefined,
    temporary: temporary[selectedId ?? ''] ?? [],
    setTemporary: (pairs: Pair[]) => { if (!lock.current && selectedId) { setTemporary(prev => ({ ...prev, [selectedId]: pairs })); setPreview(null); } },
    selectRequest: (id: string) => {
      if (selectedId === id || !projectRequests.some(r => r.id === id)) return;
      void switchContext(() => { setSelectedId(id); setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); });
    },
    selectProject: (id: string) => void switchContext(() => { mutate(w => ({ ...w, activeProjectId: id })); setSelectedId(null); }),
    selectEnvironment: (id: string) => void switchContext(() => mutate(w => ({ ...w, projects: w.projects.map(p => p.id === project?.id ? { ...p, activeEnvironmentId: id || null } : p) }))),
    loadDemo: () => { if (!desktop) { setWorkspace(demoWorkspace()); setSelectedId('demo-list'); setOpenTabs(['demo-list']); setDirty(false); } },
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
