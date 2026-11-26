import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { ColorDot } from './ColorPicker';

type Option = { value: string; label: string; color?: string; isProduction?: boolean };
type Props = {
  label: string; value: string; options: Option[]; onChange: (value: string) => void;
  disabled?: boolean; placeholder?: string; fallbackColor?: string;
};

export function ColorSelect({ label, value, options, onChange, disabled = false, placeholder = '请选择', fallbackColor }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.value === value);
  const expanded = open && !disabled && options.length > 0;
  const activeIndex = Math.min(active, options.length - 1);
  useEffect(() => { setOpen(false); }, [disabled, value]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  useEffect(() => {
    if (expanded) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded, activeIndex, id]);
  const show = () => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    search.current = { text: '', time: 0 };
    setOpen(true);
  };
  const choose = (option: Option) => {
    if (disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || !options.length) return;
    const { key } = event;
    if (key === 'Tab') { setOpen(false); return; }
    if (key === 'Escape') {
      if (expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault();
      if (!expanded) { show(); return; }
      if (key === 'Enter' || key === ' ') { choose(options[activeIndex]); return; }
      setActive(key === 'Home' ? 0 : key === 'End' ? options.length - 1 : (activeIndex + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return;
    }
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (!expanded) show();
      const now = Date.now();
      const text = (now - search.current.time > 600 ? '' : search.current.text) + key.toLocaleLowerCase();
      search.current = { text, time: now };
      const match = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text));
      if (match >= 0) setActive(match);
    }
  };
  const content = (option: Option) => <><ColorDot color={option.color} fallback={fallbackColor} /><span className="ellipsis">{option.label}</span>{option.isProduction && <span className="production-tag">生产</span>}</>;
  return <div className="color-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} type="button" className="color-select-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined} aria-activedescendant={expanded ? `${id}-option-${activeIndex}` : undefined} disabled={disabled || !options.length} onClick={() => expanded ? setOpen(false) : show()} onKeyDown={keyDown}>
      {selected ? content(selected) : <span className="ellipsis">{placeholder}</span>}<ChevronDown size={14} aria-hidden="true" />
    </button>
    {expanded && <div id={`${id}-list`} role="listbox" aria-label={label} className="color-select-list">
      {options.map((option, index) => <div id={`${id}-option-${index}`} key={option.value} role="option" aria-selected={option.value === value} data-active={index === activeIndex} className="color-select-option" onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
        {content(option)}{option.value === value && <Check size={14} className="color-select-check" aria-hidden="true" />}
      </div>)}
    </div>}
  </div>;
}
