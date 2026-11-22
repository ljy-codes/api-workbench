import { useId } from 'react';

export const PROJECT_COLOR = '#A596FF';
export const ENVIRONMENT_COLOR = '#65D7C5';
const PRESETS = [PROJECT_COLOR, ENVIRONMENT_COLOR, '#82BAFA', '#E3BD6C', '#F18D97', '#C99FE8', '#FFFFFF', '#9294A8'];
export const isHexColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
export const displayColor = (value?: string, fallback = PROJECT_COLOR) => value && isHexColor(value) ? value.toUpperCase() : fallback;

export function ColorDot({ color, fallback }: { color?: string; fallback?: string }) {
  return <span className="color-dot" aria-hidden="true" style={{ backgroundColor: displayColor(color, fallback) }} />;
}

export function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const valid = isHexColor(value);
  return <fieldset className="color-picker">
    <legend>{label}</legend>
    <div className="color-presets" aria-label={`${label}预设`}>
      {PRESETS.map(color => <button type="button" key={color} aria-label={`预设颜色 ${color}`} aria-pressed={value.toUpperCase() === color} onClick={() => onChange(color)}><ColorDot color={color} /></button>)}
    </div>
    <label className="color-hex" htmlFor={id}><ColorDot color={value} />自定义 HEX
      <input id={id} aria-label={`${label} HEX`} value={value} onChange={event => onChange(event.target.value)} spellCheck={false} autoComplete="off" placeholder="#RRGGBB" required maxLength={7} pattern="#[0-9a-fA-F]{6}" aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined} />
    </label>
    {!valid && <p id={`${id}-error`} role="alert" className="danger-text">请输入 #RRGGBB 格式的六位十六进制颜色。</p>}
  </fieldset>;
}
