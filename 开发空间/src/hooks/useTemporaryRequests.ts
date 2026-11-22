import { useEffect, useRef, useState } from 'react';
import type { Preview, RequestDefinition, TemporaryExecuteInput } from '../types';
import type { Execution } from './useWorkbench';
import { api, desktop } from '../lib/ipc';
import { executionDiagnostics } from '../lib/request-diagnostics';
import { errorMessage, responseForExecution, uid } from '../lib/workspace';
import { useResponseBaselines } from './useResponseBaselines';

type TemporaryTab = {
  request: RequestDefinition;
  execution?: Execution;
  preview: Preview | null;
  revision: number;
};
type Session = { tabs: TemporaryTab[]; selectedId: string | null };

/** Owns only memory. Never pass these drafts to the persistent workbench. */
export function useTemporaryRequests() {
  const [session, setSession] = useState<Session>({ tabs: [], selectedId: null });
  const current = useRef(session);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const [notice, setNotice] = useState('');
  const { baseline, saveBaseline, clearBaseline, forgetBaseline } = useResponseBaselines(session.selectedId ?? '');
  const put = (change: (value: Session) => Session) => {
    if (!mounted.current) return;
    current.current = change(current.current);
    setSession(current.current);
  };
  const changeTab = (id: string, change: (tab: TemporaryTab) => TemporaryTab) => {
    put(value => ({ ...value, tabs: value.tabs.map(tab => tab.request.id === id ? change(tab) : tab) }));
  };
  const stop = (tab: TemporaryTab) => {
    if (tab.execution?.running) void api.cancel(tab.execution.id).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current.tabs.forEach(stop);
      current.current = { tabs: [], selectedId: null };
    };
  }, []);
  const open = () => {
    const id = uid();
    const request: RequestDefinition = {
      id, serviceId: '', folderId: null, name: `临时请求 ${++sequence.current}`,
      method: 'GET', path: '', query: [], headers: [], bodyType: 'none', body: '',
      timeoutMs: 30000, auth: { kind: 'none' }, form: [],
    };
    put(value => ({ tabs: [...value.tabs, { request, preview: null, revision: 0 }], selectedId: id }));
    setNotice('');
    return id;
  };
  const select = (id: string) => put(value => value.tabs.some(tab => tab.request.id === id) ? { ...value, selectedId: id } : value);
  const close = (id: string) => {
    const tab = current.current.tabs.find(tab => tab.request.id === id);
    if (!tab) return;
    put(value => {
      const index = value.tabs.findIndex(tab => tab.request.id === id);
      const tabs = value.tabs.filter(tab => tab.request.id !== id);
      return { tabs, selectedId: value.selectedId === id ? tabs[Math.min(index, tabs.length - 1)]?.request.id ?? null : value.selectedId };
    });
    stop(tab);
    forgetBaseline(id);
    setNotice('');
  };
  const closeAll = () => {
    const tabs = current.current.tabs;
    put(() => ({ tabs: [], selectedId: null }));
    tabs.forEach(stop);
    tabs.forEach(tab => forgetBaseline(tab.request.id));
    setNotice('');
  };
  const updateRequest = (patch: Partial<RequestDefinition>) => {
    // Bind callbacks to the rendered tab, including a file picker that completes after a tab switch.
    const id = session.selectedId;
    if (!id) return;
    changeTab(id, tab => ({
      ...tab, request: { ...tab.request, ...patch, id, serviceId: '', folderId: null, environmentConfigs: undefined },
      revision: tab.revision + 1, preview: null,
    }));
  };
  const execute = async (previewOnly = false) => {
    const tab = current.current.tabs.find(tab => tab.request.id === current.current.selectedId);
    if (!tab || (!previewOnly && tab.execution?.running)) return;
    if (!desktop) { setNotice('仅内存预览，桌面版才可发送临时请求'); return; }
    const { request, revision } = tab;
    const executionId = uid();
    const input: TemporaryExecuteInput = {
      executionId,
      request: structuredClone({
        url: request.path, method: request.method, query: request.query, headers: request.headers,
        bodyType: request.bodyType, body: request.body, timeoutMs: request.timeoutMs,
        auth: request.auth, form: request.form ?? [],
      }),
    };
    if (previewOnly) {
      try {
        const preview = await api.previewTemporary(input);
        changeTab(request.id, value => value.revision === revision ? { ...value, preview } : value);
      } catch {
        if (mounted.current && current.current.tabs.some(value => value.request.id === request.id && value.revision === revision)) {
          setNotice('临时地址预览失败，请检查完整 HTTP/HTTPS URL 和请求配置。');
        }
      }
      return;
    }
    changeTab(request.id, value => ({
      ...value, execution: {
        id: executionId, requestId: request.id, requestName: request.name,
        environment: '无环境 · 临时请求', running: true,
      },
    }));
    const changeExecution = (patch: Partial<Execution>) => changeTab(request.id, value =>
      value.execution?.id === executionId ? { ...value, execution: { ...value.execution, ...patch } } : value);
    try {
      const result = await api.sendTemporary(input);
      const response = responseForExecution(executionId, result);
      if (!response) throw new Error('响应执行 ID 不匹配，已拒绝显示');
      changeExecution({ response, diagnostics: response.diagnostics });
    } catch (error) {
      changeExecution({ error: errorMessage(error), diagnostics: executionDiagnostics(error) });
    } finally {
      changeExecution({ running: false });
    }
  };
  const cancel = async () => {
    const tab = current.current.tabs.find(tab => tab.request.id === current.current.selectedId);
    const execution = tab?.execution;
    if (!execution?.running || execution.cancelRequested) return;
    try {
      await api.cancel(execution.id);
      changeTab(tab!.request.id, value => value.execution?.id === execution.id && value.execution.running
        ? { ...value, execution: { ...value.execution, cancelRequested: true } } : value);
    } catch {
      if (mounted.current) setNotice('取消临时请求失败，请重试。');
    }
  };
  const selected = session.tabs.find(tab => tab.request.id === session.selectedId);
  return {
    tabs: session.tabs, selectedId: session.selectedId, request: selected?.request,
    execution: selected?.execution, preview: selected?.preview ?? null,
    hasRunning: session.tabs.some(tab => tab.execution?.running), busy: false,
    baseline, saveBaseline, clearBaseline,
    notice, setNotice, open, select, close, closeAll, updateRequest, execute, cancel,
    clearResponse: () => {
      if (selected && !selected.execution?.running) changeTab(selected.request.id, value => ({ ...value, execution: undefined }));
    },
    pickFile: () => api.pickFile(),
  };
}

export type TemporaryRequestsModel = ReturnType<typeof useTemporaryRequests>;
