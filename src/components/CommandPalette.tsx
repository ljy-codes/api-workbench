import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search } from 'lucide-react';
import { formatShortcut, type CommandDefinition, type CommandId } from '../lib/commands';
import { Dialog } from './Dialog';

export function CommandPalette({ commands, disabled = new Set(), onExecute, onClose }: {
  commands: readonly CommandDefinition[];
  disabled?: ReadonlySet<string>;
  onExecute: (command: CommandDefinition) => void;
  onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return [...commands];
    return commands.filter(command => [command.label, command.group, command.description ?? '', ...command.keywords]
      .join(' ').toLocaleLowerCase().includes(term));
  }, [commands, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, visible.length - 1)));
  }, [visible.length]);

  const move = (direction: 1 | -1) => {
    if (!visible.length) return;
    setSelectedIndex(index => (index + direction + visible.length) % visible.length);
  };
  const execute = (command: CommandDefinition | undefined) => {
    if (!command || disabled.has(command.id)) return;
    onExecute(command);
    onClose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); setSelectedIndex(0); }
    else if (event.key === 'End') { event.preventDefault(); setSelectedIndex(Math.max(0, visible.length - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); execute(visible[selectedIndex]); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };

  return <Dialog title="命令面板" onClose={onClose} className="command-palette">
    <div className="command-palette-search">
      <Search size={16} aria-hidden="true" />
      <input ref={searchRef} autoFocus type="search" role="searchbox" aria-label="搜索命令" placeholder="搜索命令或关键词" value={query} onChange={event => { setQuery(event.target.value); setSelectedIndex(0); }} onKeyDown={handleKeyDown} />
      <kbd>Esc</kbd>
    </div>
    <div className="command-palette-list" role="listbox" aria-label="可执行命令">
      {!visible.length && <p className="command-palette-empty">没有匹配的命令</p>}
      {visible.map((command, index) => {
        const isDisabled = disabled.has(command.id as CommandId);
        return <button key={command.id} type="button" role="option" aria-selected={index === selectedIndex} disabled={isDisabled} title={isDisabled ? '当前状态不可用' : command.description} onMouseEnter={() => setSelectedIndex(index)} onClick={() => execute(command)}>
          <span className="command-palette-command"><span className="command-palette-check">{index === selectedIndex && !isDisabled ? <Check size={14} aria-hidden="true" /> : null}</span><span><strong>{command.label}</strong><small>{command.group}{isDisabled ? ' · 当前不可用' : ''}</small></span></span>
          {command.shortcut && <kbd>{formatShortcut(command.shortcut)}</kbd>}
        </button>;
      })}
    </div>
    <footer className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>执行</span><span><kbd>Esc</kbd>关闭</span></footer>
  </Dialog>;
}
