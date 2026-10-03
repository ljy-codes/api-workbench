import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ExecuteInput, Preview, ResponseData, Workspace } from '../types';

export const desktop = isTauri();
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) return Promise.reject(new Error('仅内存预览，桌面版才可保存和发送'));
  return invoke<T>(command, args);
}
export const api = {
  load: () => call<Workspace>('load_workspace'),
  save: (workspace: Workspace) => call<Workspace>('save_workspace', { workspace }),
  preview: (input: ExecuteInput) => call<Preview>('preview_request', { input }),
  send: (input: ExecuteInput) => call<ResponseData>('send_request', { input }),
  cancel: (executionId: string) => call<void>('cancel_request', { executionId }),
  pickFile: () => call<string | null>('pick_upload_file'),
  readProjectFile: () => call<string | null>('read_project_file'),
  writeProjectFile: (content: string) => call<string | null>('write_project_file', { content }),
  exportCurl: (input: ExecuteInput) => call<string>('export_curl', { input }),
  backup: () => call<string>('backup_workspace'),
  loadResponse: (requestId: string, environmentId: string) => call<ResponseData | null>('load_response', { requestId, environmentId }),
  saveResponse: (requestId: string, environmentId: string, response: ResponseData) => call<void>('save_response', { requestId, environmentId, response }),
  clearResponse: (requestId: string, environmentId: string) => call<void>('clear_response', { requestId, environmentId }),
  clearResponses: () => call<void>('clear_responses'),
  compactStorage: () => call<void>('compact_storage'),
};
