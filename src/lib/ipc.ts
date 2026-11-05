import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DetailedExecutionResult, ExecuteInput, Preview, ResponseData, Workspace } from '../types';
import { RequestExecutionError } from './request-diagnostics';

export const desktop = isTauri();
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) return Promise.reject(new Error('仅内存预览，桌面版才可保存和发送'));
  return invoke<T>(command, args);
}
export const api = {
  load: () => call<Workspace>('load_workspace'),
  save: (workspace: Workspace) => call<Workspace>('save_workspace', { workspace }),
  preview: (input: ExecuteInput) => call<Preview>('preview_request', { input }),
  send: async (input: ExecuteInput): Promise<ResponseData> => {
    const result = await call<DetailedExecutionResult>('send_request_detailed', { input });
    if (result.response) return result.response;
    throw new RequestExecutionError(result.error ?? '请求未完成', result.diagnostics);
  },
  cancel: (executionId: string) => call<void>('cancel_request', { executionId }),
  pickFile: () => call<string | null>('pick_upload_file'),
  readProjectFile: () => call<string | null>('read_project_file'),
  writeProjectFile: (content: string) => call<string | null>('write_project_file', { content }),
  writeInvestigationReport: (content: string) => call<string | null>('write_investigation_report', { content }),
  exportCurl: (input: ExecuteInput) => call<string>('export_curl', { input }),
  backup: () => call<string>('backup_workspace'),
  loadResponse: (requestId: string, environmentId: string) => call<ResponseData | null>('load_response', { requestId, environmentId }),
  saveResponse: (requestId: string, environmentId: string, response: ResponseData) => call<void>('save_response', { requestId, environmentId, response }),
  clearResponse: (requestId: string, environmentId: string) => call<void>('clear_response', { requestId, environmentId }),
  clearResponses: () => call<void>('clear_responses'),
  compactStorage: () => call<void>('compact_storage'),
};
