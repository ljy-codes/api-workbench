import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Confirmation } from '../components/Dialog';
import { errorMessage } from '../lib/workspace';

type CloseGuardOptions = {
  desktop: boolean;
  dirty: boolean;
  running: boolean;
  busy: boolean;
  dialogOpen: boolean;
  confirm: (options: Omit<Confirmation, 'resolve'>) => Promise<boolean>;
  onError: (message: string) => void;
};

export function useNativeClose(options: CloseGuardOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.desktop) return;
    let disposed = false;
    let confirming = false;
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    void window.onCloseRequested(async event => {
      const state = latest.current;
      if (!state.dirty && !state.running && !state.busy && !state.dialogOpen && !confirming) return;
      // Tauri's cancellation must happen synchronously, before awaiting a React dialog.
      event.preventDefault();
      if (confirming || state.dialogOpen || disposed) return;
      confirming = true;
      try {
        const message = [
          state.dirty ? '工作区有尚未保存的修改，关闭后这些修改将丢失。' : '',
          state.running || state.busy ? '仍有请求正在运行或准备中。关闭窗口会中断本地等待，但服务端可能仍在执行，不代表回滚。' : '',
          '确定关闭工作台吗？',
        ].filter(Boolean).join('\n');
        const approved = await state.confirm({ title: '确认关闭工作台', message, danger: true, confirmLabel: '仍然关闭' });
        // destroy bypasses close-requested so the same confirmation cannot recur.
        if (approved && !disposed) await window.destroy();
      } catch (error) {
        if (!disposed) latest.current.onError(`关闭窗口失败：${errorMessage(error)}`);
      } finally {
        confirming = false;
      }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => {
      if (!disposed) latest.current.onError(`未能启用原生关闭保护，请先保存修改：${errorMessage(error)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [options.desktop]);
}
