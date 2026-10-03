import { useRef } from 'react';

export function ResizeHandle({ label, value, min, max, onChange, orientation, disabled = false }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void; orientation: 'vertical' | 'horizontal'; disabled?: boolean;
}) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const clamp = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return <div role="separator" tabIndex={disabled ? -1 : 0} aria-label={label} aria-orientation={orientation} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} 像素`} aria-disabled={disabled}
    className={`resize-handle ${orientation}`} title="拖动调整；方向键微调，Home / End 到最小 / 最大"
    onKeyDown={e => {
      if (disabled) return;
      const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      if (![increase, decrease, 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      clamp(e.key === 'Home' ? min : e.key === 'End' ? max : value + (e.key === increase ? 1 : -1) * (e.shiftKey ? 40 : 10));
    }}
    onPointerDown={e => {
      if (disabled || e.button !== 0) return;
      e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { start: orientation === 'vertical' ? e.clientX : e.clientY, value };
    }}
    onPointerMove={e => {
      if (!disabled && drag.current) clamp(drag.current.value + (orientation === 'vertical' ? e.clientX : e.clientY) - drag.current.start);
    }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
  />;
}
