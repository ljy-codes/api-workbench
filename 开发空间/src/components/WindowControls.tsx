import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { desktop } from '../lib/ipc';

export function WindowControls() {
  if (!desktop) return null;

  const minimize = () => { void getCurrentWindow().minimize(); };
  const toggleMaximize = () => { void getCurrentWindow().toggleMaximize(); };
  const close = () => { void getCurrentWindow().close(); };

  return <div className="window-controls" aria-label="窗口控制">
    <button type="button" className="window-control" aria-label="最小化窗口" title="最小化" onClick={minimize}><Minimize2 size={15} /></button>
    <button type="button" className="window-control" aria-label="最大化或还原窗口" title="最大化或还原" onClick={toggleMaximize}><Maximize2 size={15} /></button>
    <button type="button" className="window-control window-control-close" aria-label="关闭窗口" title="关闭" onClick={close}><X size={16} /></button>
  </div>;
}
