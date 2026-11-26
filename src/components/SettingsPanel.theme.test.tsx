/// <reference types="node" />
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageKey = 'envdock.preferences.v1';
// Vitest disables CSS imports; load and apply the actual stylesheet through CSSOM.
const themeCss = readFileSync(resolve('src/themes.css'), 'utf8');
let sheet: HTMLStyleElement;
const dialogMethods = Object.fromEntries(['showModal', 'close'].map(name =>
  [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)],
));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  sheet = document.createElement('style');
  sheet.textContent = themeCss;
  document.head.append(sheet);
  // jsdom has no modal top layer; keep the real Dialog and preference store.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

afterEach(() => {
  cleanup();
  sheet.remove();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderSettings() {
  const { default: SettingsPanel } = await import('./SettingsPanel');
  const { usePreferences } = await import('../hooks/usePreferences');
  const { useWorkbench } = await import('../hooks/useWorkbench');
  function Settings() {
    return <SettingsPanel model={useWorkbench()} {...usePreferences()} onClose={() => {}} />;
  }
  return render(<Settings />);
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgb(hex: string): number[] {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => rgb(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('1.8.0 外观设置', () => {
  it('只提供四种主题，选择石墨黑即时应用并保存，重开设置保持选中', async () => {
    const first = await renderSettings();
    const appearance = within(screen.getByRole('region', { name: '外观设置' }));
    expect(appearance.getAllByRole('button')).toHaveLength(4);
    expect(appearance.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(appearance.getByRole('button', { name: '石墨黑' }));

    expect(appearance.getByRole('button', { name: '石墨黑' })).toHaveAttribute('aria-pressed', 'true');
    expect(appearance.getAllByRole('button', { pressed: true })).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe('graphite');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ theme: 'graphite' });

    first.unmount();
    await renderSettings();
    expect(screen.getByRole('button', { name: '石墨黑' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    ['light', '浅色', 'light'],
    ['dark', '深色', 'dark'],
    ['system', '跟随系统', 'light'],
    ['graphite', '石墨黑', 'graphite'],
  ] as const)('可选择 %s：%s', async (theme, name, appliedTheme) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe(appliedTheme);
    if (theme === 'dark') expect(localStorage.getItem(storageKey)).toBeNull();
    else expect(JSON.parse(localStorage.getItem(storageKey)!).theme).toBe(theme);
  });

  it.each(['soft', 'dusk'] as const)('旧版 %s 偏好回退到深色，且不改写原存储', async theme => {
    const saved = JSON.stringify({ theme, sidebarWidth: 310 });
    localStorage.setItem(storageKey, saved);
    await renderSettings();
    expect(screen.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(storageKey)).toBe(saved);
  });

  it('恢复默认布局保留石墨黑主题', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'graphite', sidebarWidth: 310, layout: 'side-by-side' }));
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '布局' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认布局' }));
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      theme: 'graphite', sidebarWidth: 240, layout: 'stacked',
    });
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    expect(screen.getByRole('button', { name: '石墨黑' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('石墨黑调色板', () => {
  it('三套主题提供完全一致的令牌集合', () => {
    const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    const properties = (style: CSSStyleDeclaration) =>
      Array.from({ length: style.length }, (_, index) => style[index]).filter(name => name.startsWith('--')).sort();
    const themes = ['dark', 'light', 'graphite'].map(theme => {
      const selector = theme === 'dark' ? ':root,\n:root[data-theme=dark]' : `:root[data-theme=${theme}]`;
      const rule = rules.find(item => item.selectorText === selector || item.selectorText?.includes(`data-theme=${theme}`));
      expect(rule, `缺少 ${theme} 主题令牌`).toBeDefined();
      return properties(rule!.style);
    });
    expect(themes[1]).toEqual(themes[0]);
    expect(themes[2]).toEqual(themes[0]);
  });

  it('完整覆盖深色主题令牌，并明确区分请求体和响应体', () => {
    const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    const properties = (style: CSSStyleDeclaration) =>
      Array.from({ length: style.length }, (_, index) => style[index]).filter(name => name.startsWith('--')).sort();
    const baseline = rules.find(rule => rule.selectorText.includes('data-theme=dark'))!;
    const graphite = rules.find(rule => rule.selectorText === ':root[data-theme=graphite]');
    expect(graphite, '缺少独立石墨黑调色板').toBeDefined();
    expect(properties(graphite!.style)).toEqual(properties(baseline.style));

    document.documentElement.dataset.theme = 'graphite';
    expect(getComputedStyle(document.documentElement).colorScheme).toBe('dark');
    expect(token('--bg')).toBe('#171717');
    expect(token('--request-code-bg')).toBe('#141923');
    expect(token('--response-code-bg')).toBe('#2b2a28');
    expect(token('--request-code-bg')).not.toBe(token('--response-code-bg'));
    expect(token('--separator')).not.toBe(token('--border'));
    expect(token('--separator-hover')).not.toBe(token('--accent'));
  });

  it('正文与 JSON 语法颜色在请求体和响应体上保持可读', () => {
    document.documentElement.dataset.theme = 'graphite';
    const syntax = ['--code-key', '--code-string', '--code-number', '--code-literal'];
    expect(new Set(syntax.map(token)).size).toBe(4);
    for (const background of ['--request-code-bg', '--response-code-bg', '--code-active-line']) {
      for (const foreground of [...syntax, '--code-text', '--code-punctuation']) {
        expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(token('--code-gutter'), token('--request-code-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--code-punctuation'), token('--response-code-bg'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(['dark', 'light', 'graphite'])('%s 主题的信息层次', theme => {
  beforeEach(() => { document.documentElement.dataset.theme = theme; });

  it('请求响应底色分别配置，普通文字、选中状态和主操作可读', () => {
    const request = token('--request-code-bg'), response = token('--response-code-bg');
    expect(request).not.toBe(response);
    for (const background of [request, response]) {
      for (const foreground of ['--code-text', '--code-key', '--code-string', '--code-number', '--code-literal', '--code-punctuation']) {
        expect(contrast(token(foreground), background), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const background of ['--bg', '--panel', '--surface-subtle', '--panel-raised', '--button-bg', '--button-hover', '--accent-soft']) {
      for (const foreground of ['--text', '--text-secondary', '--muted', '--accent']) {
        expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(token('--primary-text'), token('--primary-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--selection-text'), token('--accent-soft'))).toBeGreaterThanOrEqual(4.5);
  });
});
