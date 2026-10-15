export type ThemeMode = 'dark' | 'light' | 'system';

export interface Preferences {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  layout: 'stacked' | 'side-by-side';
  sidebarWidth: number;
  editorHeight: number;
  editorWidth: number;
}

const storageKey = 'envdock.preferences.v1';
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  theme: 'dark', sidebarCollapsed: false, layout: 'stacked',
  sidebarWidth: 240, editorHeight: 280, editorWidth: 500,
});

let preferences = DEFAULT_PREFERENCES;
let initialized = false;
const subscribers = new Set<() => void>();
let systemTheme: MediaQueryList | undefined;
let removeSystemListener: (() => void) | undefined;

function pixels(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function normalize(value: unknown): Preferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.freeze({
    theme: input.theme === 'light' || input.theme === 'system' ? input.theme : 'dark',
    sidebarCollapsed: typeof input.sidebarCollapsed === 'boolean' ? input.sidebarCollapsed : false,
    layout: input.layout === 'side-by-side' ? 'side-by-side' : 'stacked',
    sidebarWidth: pixels(input.sidebarWidth, DEFAULT_PREFERENCES.sidebarWidth, 200, 420),
    editorHeight: pixels(input.editorHeight, DEFAULT_PREFERENCES.editorHeight, 160, 720),
    editorWidth: pixels(input.editorWidth, DEFAULT_PREFERENCES.editorWidth, 300, 900),
  });
}

function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const theme = preferences.theme === 'system'
    ? (systemTheme ? (systemTheme.matches ? 'dark' : 'light') : 'dark')
    : preferences.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function stopSystemTheme(): void {
  removeSystemListener?.();
  removeSystemListener = undefined;
  systemTheme = undefined;
}

function watchSystemTheme(): void {
  if (preferences.theme !== 'system') { stopSystemTheme(); return; }
  if (systemTheme || typeof window === 'undefined') return;
  try {
    systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof systemTheme.addEventListener === 'function') {
      systemTheme.addEventListener('change', applyTheme);
      const media = systemTheme;
      removeSystemListener = () => media.removeEventListener('change', applyTheme);
    } else if (typeof systemTheme.addListener === 'function') {
      systemTheme.addListener(applyTheme);
      const media = systemTheme;
      removeSystemListener = () => media.removeListener(applyTheme);
    }
  } catch {
    // Some embedded browsers expose no usable media-query API.
    stopSystemTheme();
  }
}

/** Apply the saved theme synchronously before React renders. Safe to call again. */
export function initializePreferences(): void {
  if (initialized) return;
  try {
    preferences = normalize(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null'));
  } catch {
    // Storage may be corrupt, disabled or unavailable; keep the app usable in memory.
    preferences = DEFAULT_PREFERENCES;
  }
  initialized = true;
  watchSystemTheme();
  applyTheme();
}

export function getPreferences(): Preferences {
  initializePreferences();
  return preferences;
}

export function subscribePreferences(listener: () => void): () => void {
  initializePreferences();
  subscribers.add(listener);
  watchSystemTheme();
  applyTheme();
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) stopSystemTheme();
  };
}

export function updatePreferences(patch: Partial<Preferences>): void {
  initializePreferences();
  const next = normalize({ ...preferences, ...patch });
  const changed = (Object.keys(next) as (keyof Preferences)[])
    .some(key => next[key] !== preferences[key]);
  if (!changed) return;
  preferences = next;
  watchSystemTheme();
  applyTheme();
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // A failed write must not undo an already-applied preference.
  }
  for (const listener of subscribers) listener();
}
