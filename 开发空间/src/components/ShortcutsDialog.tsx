import { useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import { SHORTCUT_ENTRIES, formatShortcut, type CommandDefinition } from '../lib/commands';
import { Dialog } from './Dialog';

export function ShortcutsDialog({ commands, onClose }: { commands: readonly CommandDefinition[]; onClose: () => void }) {
  const groups = useMemo(() => {
    const commandIds = new Set(commands.map(command => command.id));
    const entries = SHORTCUT_ENTRIES.filter(entry => {
      const command = commands.find(item => item.label === entry.label);
      return !command || commandIds.has(command.id);
    });
    const order = ['导航', '工作台', '标签', '请求与响应', '工具'] as const;
    return order.map(label => ({ label, entries: entries.filter(entry => entry.group === label) })).filter(group => group.entries.length);
  }, [commands]);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return <Dialog title="快捷键总览" onClose={onClose} className="shortcuts-dialog">
    <div className="shortcuts-intro"><Keyboard size={18} /><span>常用操作集中在这里，命令面板也可以搜索同一组动作。</span></div>
    <div className="shortcuts-groups">
      {groups.map(group => <section key={group.label} aria-label={group.label}>
        <h3>{group.label}</h3>
        <div className="shortcuts-list">{group.entries.map((entry, index) => <div className="shortcut-row" key={`${entry.label}-${index}`}><span>{entry.label}</span><kbd>{formatShortcut(entry.shortcut, mac)}</kbd></div>)}</div>
      </section>)}
    </div>
  </Dialog>;
}
