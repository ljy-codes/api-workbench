import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecuteInput, Pair, Preview, RequestDefinition, RequestDiagnostics, RequestHistoryEntry, ResponseData, Workspace } from '../types';
import type { Confirmation } from '../components/Dialog';
import { api, desktop } from '../lib/ipc';
import { demoWorkspace, emptyWorkspace, errorMessage, responseForExecution, uid } from '../lib/workspace';
import { cleanRequestBodies, executionKey, resolveRequest, updateEnvironmentRequest } from '../lib/environment';
import { unifyServiceAddresses } from '../lib/service-addresses';
import type { ImportBundle, TransferSelection } from '../lib/transfer';
import type { OpenApiPreview } from '../lib/openapi';
import { appendHistory, historyRequestSnapshot, restoreHistoryDraft } from '../lib/request-history';
import { executionDiagnostics } from '../lib/request-diagnostics';
import { addClosedTabs, discardClosedTab, nextClosedTab, removeInvalidClosedTabs, type ClosedTab } from '../lib/closed-tabs';

export type Execution = { id: string; requestId: string; environment: string; requestName: string; running: boolean; response?: ResponseData; error?: string; cancelRequested?: boolean; diagnostics?: RequestDiagnostics };
export function useWorkbench() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);
  const [loading, setLoading] = useState(desktop);
  const [loadVersion, setLoadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [executions, setExecutions] = useState<Record<string, Execution>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [temporary, setTemporary] = useState<Record<string, Pair[]>>({});
  const [history, setHistory] = useState<RequestHistoryEntry[]>([]);
  const historyRef = useRef<RequestHistoryEntry[]>([]);
  const historyEpoch = useRef(0);
  const projectHistoryEpoch = useRef(new Map<string, number>());
  const lock = useRef(false);
  const running = useRef(new Set<string>());
  const wsRef = useRef(workspace);
  const dirtyRef = useRef(false);
  const responseEpoch = useRef(0);
  const executionRef = useRef(executions);
  const putHistory = (next: RequestHistoryEntry[]) => {
    historyRef.current = next;
    setHistory(next);
  };
  const clearHistory = (projectId?: string) => {
    if (projectId) {
      projectHistoryEpoch.current.set(projectId, (projectHistoryEpoch.current.get(projectId) ?? 0) + 1);
      putHistory(historyRef.current.filter(entry => entry.projectId !== projectId));
    } else {
      historyEpoch.current++;
      putHistory([]);
    }
  };
  const putExecutions = (change: (value: Record<string, Execution>) => Record<string, Execution>) => {
    executionRef.current = change(executionRef.current);
    setExecutions(executionRef.current);
  };
  const acceptWorkspace = (w: Workspace, isDirty: boolean) => {
    wsRef.current = w; dirtyRef.current = isDirty;
    setWorkspace(w); setDirty(isDirty);
  };
  const confirm = useCallback((options: Omit<Confirmation, 'resolve'>) => new Promise<boolean>(resolve => setConfirmation({ ...options, resolve })), []);
  const load = useCallback(async () => {
    // Use refs: the initial effect starts with loading=true and load must stay stable.
    if (lock.current) return;
    if (running.current.size) { setNotice('仍有请求进行中，请完成或取消后再重新加载。'); return; }
    if (dirtyRef.current) { setNotice('工作区有未保存修改，请先保存再重新加载；草稿已保留。'); return; }
    lock.current = true; setBusy(true); setLoading(true);
    try {
      const loaded = await api.load();
      const w = unifyServiceAddresses(loaded);
      const first = w.requests.find(r => w.services.some(s => s.id === r.serviceId && s.projectId === w.activeProjectId))?.id ?? null;
      acceptWorkspace(w, w !== loaded); responseEpoch.current++;
      if (w !== loaded) setNotice('已将无引用的重复地址统一到环境矩阵；请保存全部修改，原有接口与变量引用保留。');
      putExecutions(() => ({}));
      setLoadVersion(version => version + 1);
      setSelectedId(first); setOpenTabs(first ? [first] : []); setClosedTabs([]);
    }
    catch (error) { setNotice(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); setLoading(false); }
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
    acceptWorkspace(change(wsRef.current), true);
    setPreview(null);
  };
  const saveSnapshot = async (w: Workspace) => {
    const saved = await api.save(w);
    acceptWorkspace(saved, false);
    return saved;
  };
  const save = async () => {
    if (lock.current || loading || confirmation) return;
    if (!desktop) { setNotice('仅内存预览，桌面版才可保存和发送'); return; }
    lock.current = true; setBusy(true);
    try { if (dirtyRef.current) await saveSnapshot(wsRef.current); }
    catch (e) { setNotice(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const switchContext = async (action: () => void, change?: (w: Workspace) => Workspace): Promise<boolean> => {
    if (lock.current || loading || confirmation) return false;
    lock.current = true; setBusy(true);
    try {
      const next = change ? change(wsRef.current) : wsRef.current;
      if (desktop && (dirtyRef.current || next !== wsRef.current)) await saveSnapshot(next);
      else if (next !== wsRef.current) acceptWorkspace(next, true);
      action(); setPreview(null);
      return true;
    } catch (error) { setNotice(`自动保存失败，已保留草稿并停止切换：${errorMessage(error)}`); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const project = workspace.projects.find(p => p.id === workspace.activeProjectId);
  const environment = workspace.environments.find(e => e.id === project?.activeEnvironmentId);
  const projectRequests = workspace.requests.filter(r => workspace.services.some(s => s.id === r.serviceId && s.projectId === project?.id));
  const storedRequest = projectRequests.find(r => r.id === selectedId);
  const request = storedRequest ? resolveRequest(storedRequest, environment?.id ?? null) : undefined;
  const selectedKey = selectedId && environment ? executionKey(selectedId, environment.id) : null;
  useEffect(() => {
    if (!desktop || !selectedId || !environment?.id || !storedRequest) return;
    const key = executionKey(selectedId, environment.id);
    const epoch = responseEpoch.current;
    let cancelled = false;
    // Fetch only on context entry. Never let an old DB read overwrite an execution.
    if (!executionRef.current[key]) {
      void api.loadResponse(selectedId, environment.id).then(response => {
        if (cancelled || epoch !== responseEpoch.current || executionRef.current[key] || !response) return;
        putExecutions(prev => ({ ...prev, [key]: {
          id: response.executionId, requestId: selectedId, environment: response.environmentName,
          requestName: storedRequest.name, running: false, response,
        } }));
      }).catch(error => { if (!cancelled) setNotice(`读取响应缓存失败：${errorMessage(error)}`); });
    }
    return () => { cancelled = true; };
  }, [selectedId, environment?.id, storedRequest?.id, loadVersion]);
  useEffect(() => {
    setOpenTabs(tabs => tabs.filter(id => workspace.requests.some(r => r.id === id)));
    if (project?.id) {
      setClosedTabs(tabs => removeInvalidClosedTabs(tabs, {
        projectId: project.id,
        requestIds: new Set(projectRequests.map(item => item.id)),
        openTabs: new Set(openTabs),
      }));
    }
    if (selectedId && !storedRequest) { setSelectedId(null); setPreview(null); }
  }, [workspace.requests, selectedId, storedRequest, project?.id]);
  const updateRequest = (patch: Partial<RequestDefinition>) => {
    if (lock.current || !selectedId) return;
    try { mutate(w => updateEnvironmentRequest(w, selectedId, environment?.id ?? null, patch)); }
    catch (error) { setNotice(errorMessage(error)); }
  };
  const execute = async (previewOnly = false, exportOnly = false) => {
    if (lock.current || loading || confirmation || !request || !environment || (!previewOnly && !exportOnly && running.current.has(executionKey(request.id, environment.id)))) return;
    if (!desktop) { setNotice('仅内存预览，桌面版才可保存和发送'); return; }
    lock.current = true; setBusy(true);
    // Capture identity before any asynchronous confirmation; environment changes cannot retarget it.
    const requestId = request.id;
    const environmentId = environment.id;
    const key = executionKey(requestId, environmentId);
    const executionId = uid();
    let preparationReleased = false;
    try {
      if (dirtyRef.current) await saveSnapshot(wsRef.current);
      const savedRequest = wsRef.current.requests.find(r => r.id === requestId);
      if (!savedRequest) throw new Error('接口已不存在');
      const capturedRequest = resolveRequest(savedRequest, environmentId);
      const input: ExecuteInput = { executionId, environmentId, request: structuredClone(capturedRequest), temporaryVariables: structuredClone(temporary[key] ?? []), productionConfirmed: false };
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
      const service = wsRef.current.services.find(service => service.id === capturedRequest.serviceId)!;
      const capturedProject = wsRef.current.projects.find(project => project.id === service.projectId)!;
      const capturedEpoch = historyEpoch.current;
      const capturedProjectEpoch = projectHistoryEpoch.current.get(capturedProject.id) ?? 0;
      const startedAt = Date.now();
      const historySnapshot = {
        id: executionId, projectId: capturedProject.id, projectName: capturedProject.name,
        environmentId, environmentName: prepared.environmentName, serviceName: prepared.serviceName,
        startedAt, url: prepared.url, request: historyRequestSnapshot(input.request),
        temporaryVariables: structuredClone(input.temporaryVariables),
      };
      let recordedResponse: ResponseData | undefined;
      let recordedError: string | undefined;
      let recordedDiagnostics: RequestDiagnostics | undefined;
      const sendStarted = performance.now();
      let finishedAt = startedAt;
      let clientDurationMs = 0;
      running.current.add(key);
      putExecutions(prev => ({ ...prev, [key]: { id: executionId, requestId, environment: prepared.environmentName, requestName: capturedRequest.name, running: true } }));
      lock.current = false; setBusy(false);
      preparationReleased = true;
      try {
        const result = await api.send(input);
        finishedAt = Date.now();
        clientDurationMs = Math.round(performance.now() - sendStarted);
        const response = responseForExecution(executionId, result);
        if (!response) throw new Error('响应执行 ID 不匹配，已拒绝显示');
        recordedResponse = response;
        recordedDiagnostics = response.diagnostics;
        putExecutions(prev => prev[key]?.id === executionId ? { ...prev, [key]: { ...prev[key], response, diagnostics: response.diagnostics } } : prev);
        // A request may have been deleted while the network was running.
        if (wsRef.current.requests.some(r => r.id === requestId) && wsRef.current.environments.some(e => e.id === environmentId)) {
          try { await api.saveResponse(requestId, environmentId, response); }
          catch (error) { setNotice(`响应已收到，但本地缓存保存失败：${errorMessage(error)}`); }
        }
      } catch (error) {
        finishedAt = Date.now();
        clientDurationMs = Math.round(performance.now() - sendStarted);
        recordedError = errorMessage(error);
        recordedDiagnostics = executionDiagnostics(error);
        putExecutions(prev => prev[key]?.id === executionId ? { ...prev, [key]: { ...prev[key], error: recordedError, diagnostics: recordedDiagnostics } } : prev);
      } finally {
        if (historyEpoch.current === capturedEpoch && (projectHistoryEpoch.current.get(capturedProject.id) ?? 0) === capturedProjectEpoch) {
          const next = appendHistory(historyRef.current, {
            ...historySnapshot, finishedAt, response: recordedResponse, error: recordedError,
            diagnostics: recordedDiagnostics ?? { outcome: recordedResponse ? 'response' : 'transport', totalMs: clientDurationMs },
          });
          if (next === historyRef.current) setNotice('本次记录超过 16 MiB 时间线容量，已跳过；当前响应仍可查看。');
          else putHistory(next);
        }
        running.current.delete(key);
        putExecutions(prev => prev[key]?.id === executionId ? { ...prev, [key]: { ...prev[key], running: false } } : prev);
      }
    } catch (error) { setNotice(errorMessage(error)); }
    finally {
      // A completed network call must not release a different request's preparation lock.
      if (!preparationReleased) { lock.current = false; setBusy(false); }
    }
  };
  const cancel = async () => {
    const key = selectedKey;
    const execution = key ? executionRef.current[key] : null;
    if (!execution?.running || execution.cancelRequested) return;
    try {
      await api.cancel(execution.id);
      putExecutions(prev => prev[key!]?.id === execution.id ? { ...prev, [key!]: { ...prev[key!], cancelRequested: true } } : prev);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  const closeTabs = (ids: string[]) => {
    const projectRequestIds = new Set(projectRequests.map(request => request.id));
    const closing = new Set(ids.filter(id => projectRequestIds.has(id) && openTabs.includes(id)));
    if (!closing.size) return;
    return switchContext(() => {
      if (project?.id) {
        const closed = openTabs
          .map((requestId, index) => ({ requestId, index }))
          .filter(item => closing.has(item.requestId))
          .map(item => ({ projectId: project.id!, requestId: item.requestId, index: item.index }));
        setClosedTabs(previous => addClosedTabs(previous, closed));
      }
      const remaining = openTabs.filter(tab => !closing.has(tab));
      setOpenTabs(remaining);
      if (selectedId && closing.has(selectedId)) {
        setSelectedId([...remaining].reverse().find(tab => projectRequestIds.has(tab)) ?? null);
        setPreview(null);
      }
    });
  };
  const closeTab = (id: string) => closeTabs([id]);
  const closeAllTabs = () => closeTabs(projectRequests.map(request => request.id));
  const availableClosedTabs = project?.id
    ? removeInvalidClosedTabs(closedTabs, {
      projectId: project.id,
      requestIds: new Set(projectRequests.map(item => item.id)),
      openTabs: new Set(openTabs),
    })
    : closedTabs;
  const restoreClosedTab = async (): Promise<boolean> => {
    if (!project?.id) return false;
    const candidate = nextClosedTab(availableClosedTabs, project.id);
    if (!candidate) {
      if (availableClosedTabs.length !== closedTabs.length) setClosedTabs(availableClosedTabs);
      return false;
    }
    return switchContext(() => {
      setClosedTabs(previous => {
        const next = nextClosedTab(previous, project.id!);
        return next?.entry.requestId === candidate.entry.requestId && next.entry.index === candidate.entry.index ? next.rest : previous;
      });
      setOpenTabs(tabs => {
        const next = tabs.slice();
        const index = Math.max(0, Math.min(candidate.entry.index, next.length));
        if (!next.includes(candidate.entry.requestId)) next.splice(index, 0, candidate.entry.requestId);
        return next;
      });
      setSelectedId(candidate.entry.requestId);
      setPreview(null);
    });
  };
  const runLocalAction = async (action: () => Promise<void>, nativeOnly = false) => {
    if (lock.current || confirmation) return false;
    if (nativeOnly && !desktop) { setNotice('此功能需要桌面模式；浏览器仅保留内存草稿。'); return false; }
    lock.current = true; setBusy(true);
    try { await action(); return true; }
    catch (error) { setNotice(errorMessage(error)); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const restoreHistory = (id: string) => runLocalAction(async () => {
    const entry = historyRef.current.find(entry => entry.id === id);
    if (!entry) throw new Error('记录已移除，请重新选择。');
    // Validate before saving; then rebuild against the revision returned by save.
    restoreHistoryDraft(wsRef.current, entry);
    if (dirtyRef.current && desktop) await saveSnapshot(wsRef.current);
    acceptWorkspace(restoreHistoryDraft(wsRef.current, entry), true);
    setSelectedId(entry.request.id);
    setOpenTabs(tabs => tabs.includes(entry.request.id) ? tabs : [...tabs, entry.request.id]);
    setTemporary(previous => ({ ...previous, [executionKey(entry.request.id, entry.environmentId)]: [] }));
    setPreview(null);
    setNotice('已恢复为未发送草稿；方法和路径共用，参数属于原环境。鉴权及敏感参数沿用当前值；变量、服务公共配置使用当前值，文件需重新选择。');
  });
  const applyImport = (imported: Workspace, unifyAddresses = true) => {
    const next = unifyAddresses ? unifyServiceAddresses(imported) : imported;
    const newRequest = next.requests.find(r => !wsRef.current.requests.some(old => old.id === r.id) && next.services.some(s => s.id === r.serviceId && s.projectId === next.activeProjectId));
    acceptWorkspace(next, true); setPreview(null);
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
  const readTransferFile = async () => {
    let text: string | null = null;
    await runLocalAction(async () => { text = await api.readProjectFile(); }, true);
    return text;
  };
  const importSelected = (bundle: ImportBundle, selection: TransferSelection) => runLocalAction(async () => {
    const { importSelection } = await import('../lib/transfer');
    applyImport(importSelection(wsRef.current, bundle, selection));
  });
  const applyOpenApi = (plan: OpenApiPreview, selectedKeys: string[]) => runLocalAction(async () => {
    if (loading) throw new Error('工作区仍在加载，请稍后重新预览');
    const { applyOpenApiPreview } = await import('../lib/openapi');
    const next = applyOpenApiPreview(wsRef.current, plan, selectedKeys);
    // OpenAPI's preview preserves existing projects verbatim; global address
    // unification could remove an unrelated local variable after confirmation.
    if (plan.mode === 'new') applyImport(next, false);
    else {
      // Keep existing identities, environment variants, selections and local
      // addresses intact. This is a draft edit, never an IPC save or execution.
      acceptWorkspace(next, true); setPreview(null);
      setNotice('已按 OpenAPI 预览补齐所选接口草稿；本地配置与环境覆盖保留，未保存、未发送。');
    }
  });
  const writeSelected = async (selection: TransferSelection): Promise<boolean | null> => {
    let written = false;
    const success = await runLocalAction(async () => {
      const { exportSelection } = await import('../lib/transfer');
      const path = await api.writeProjectFile(exportSelection(wsRef.current, selection));
      if (path) { written = true; setNotice(`JSON 已导出：${path}`); }
    }, true);
    return success ? (written ? true : null) : false;
  };
  const pickFile = async () => {
    let path: string | null = null;
    await runLocalAction(async () => { path = await api.pickFile(); }, true);
    return path;
  };
  const backup = () => runLocalAction(async () => {
    const path = await api.backup();
    setNotice(`已备份已保存数据（不含内存草稿）：${path}`);
  }, true);
  const clearResponse = async () => {
    if (!selectedKey || !selectedId || !environment || running.current.has(selectedKey)) return;
    const key = selectedKey, requestId = selectedId, environmentId = environment.id;
    await runLocalAction(async () => {
      await api.clearResponse(requestId, environmentId);
      responseEpoch.current++;
      putExecutions(prev => { const next = { ...prev }; delete next[key]; return next; });
    }, true);
  };
  const cleanData = (clearBodies: boolean): Promise<boolean> => {
    if (running.current.size) { setNotice('仍有请求进行中，请完成或取消后再清理。'); return Promise.resolve(false); }
    return runLocalAction(async () => {
      if (clearBodies) await saveSnapshot(cleanRequestBodies(wsRef.current));
      try { await api.clearResponses(); }
      catch (error) {
        throw new Error(`${clearBodies ? '请求正文和表单已清空并保存；' : ''}响应缓存清理失败：${errorMessage(error)}`);
      }
      responseEpoch.current++;
      putExecutions(() => ({}));
      clearHistory();
      setPreview(null);
      try { await api.compactStorage(); }
      catch (error) { throw new Error(`数据已清理，但空间回收失败，可稍后重试：${errorMessage(error)}`); }
      setNotice(clearBodies ? '已清空所有项目的请求正文、表单内容及响应缓存；接口和其他配置保留。' : '已清空全部响应缓存并回收空间；请求配置保留。');
    }, true);
  };
  return {
    workspace, project, environment, request, selectedId, loading, busy, dirty, notice, setNotice,
    history, clearHistory, restoreHistory,
    deleteHistory: (id: string) => putHistory(historyRef.current.filter(entry => entry.id !== id)),
    confirmation, setConfirmation, confirm, mutate, updateRequest, save, execute, cancel, preview, load, clearResponse, cleanData,
    openTabs, closeTab, closeTabs, closeAllTabs, copyCurl: () => execute(false, true), importProjectText, importCurlText, readProject, writeProject, readTransferFile, importSelected, applyOpenApi, writeSelected, pickFile, backup,
    closedTabs: availableClosedTabs, canRestoreClosedTab: !!project?.id && availableClosedTabs.some(entry => entry.projectId === project.id), restoreClosedTab,
    hasRunning: Object.values(executions).some(execution => execution.running),
    execution: selectedKey ? executions[selectedKey] : undefined,
    temporary: selectedKey ? temporary[selectedKey] ?? [] : [],
    setTemporary: (pairs: Pair[]) => { if (!lock.current && selectedKey) { setTemporary(prev => ({ ...prev, [selectedKey]: pairs })); setPreview(null); } },
    selectRequest: (id: string) => {
      if (selectedId === id || !projectRequests.some(r => r.id === id)) return;
      return switchContext(() => {
        if (project?.id) setClosedTabs(previous => discardClosedTab(previous, project.id!, id));
        setSelectedId(id); setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]);
      });
    },
    selectProject: (id: string) => {
      if (id === project?.id || !workspace.projects.some(p => p.id === id)) return;
      return switchContext(() => setSelectedId(null), w => ({ ...w, activeProjectId: id }));
    },
    selectEnvironment: (id: string) => {
      if (id === (environment?.id ?? '') || (id && !workspace.environments.some(e => e.id === id && e.projectId === project?.id))) return;
      return switchContext(() => {}, w => ({ ...w, projects: w.projects.map(p => p.id === project?.id ? { ...p, activeEnvironmentId: id || null } : p) }));
    },
    loadDemo: () => { if (!desktop) { acceptWorkspace(demoWorkspace(), false); setSelectedId('demo-list'); setOpenTabs(['demo-list']); } },
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
