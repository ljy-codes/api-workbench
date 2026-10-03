import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); };
  }, []);
  return <dialog ref={ref} className={wide ? 'dialog wide' : 'dialog'} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}

export type Confirmation = { title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (result: boolean) => void };
export function ConfirmDialog({ value, close }: { value: Confirmation; close: () => void }) {
  const settle = (result: boolean) => { close(); value.resolve(result); };
  return <Dialog title={value.title} onClose={() => settle(false)}>
    <p className="confirm-message">{value.message}</p>
    <footer className="dialog-footer"><button autoFocus onClick={() => settle(false)}>取消</button><button className={value.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>{value.confirmLabel ?? '确认'}</button></footer>
  </Dialog>;
}
