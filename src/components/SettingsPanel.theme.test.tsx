/// <reference types="node" />
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageKey = 'envdock.preferences.v1';
// Vitest disables CSS imports; load and apply the actual stylesheet through CSSOM.
const themeCss = readFileSync(resolve('src/themes.css'), 'utf8');
const dialogMethods = Object.fromEntries(['showModal', 'close'].map(name =>
  [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)],
));
let sheet: HTMLStyleElement;

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

describe('设置中的第四个主题', () => {
  it('默认深色，选择雾青即时应用并保存，重开设置保持选中', async () => {
    const first = await renderSettings();
    const appearance = within(screen.getByRole('region', { name: '外观设置' }));
    expect(appearance.getAllByRole('button')).toHaveLength(4);
    expect(appearance.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(appearance.getByRole('button', { name: '雾青' }));
    expect(appearance.getByRole('button', { name: '雾青' })).toHaveAttribute('aria-pressed', 'true');
    expect(appearance.getAllByRole('button', { pressed: true })).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe('soft');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(JSON.parse(localStorage.getItem(storageKey)!).theme).toBe('soft');
    first.unmount();
    await renderSettings();
    expect(screen.getByRole('button', { name: '雾青' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each(['dark', 'light', 'system'] as const)('打开设置不迁移已有 %s 偏好，雾青可切回原主题', async theme => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const saved = JSON.stringify({ theme, sidebarWidth: 310 });
    localStorage.setItem(storageKey, saved);
    await renderSettings();
    const names = { dark: '深色', light: '浅色', system: '跟随系统' };
    expect(screen.getByRole('button', { name: names[theme] })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem(storageKey)).toBe(saved);
    fireEvent.click(screen.getByRole('button', { name: '雾青' }));
    fireEvent.click(screen.getByRole('button', { name: names[theme] }));
    expect(screen.getByRole('button', { name: names[theme] })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe(theme === 'system' ? 'light' : theme);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ theme, sidebarWidth: 310 });
  });

  it('恢复默认布局保留雾青主题', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'soft', sidebarWidth: 310, layout: 'side-by-side' }));
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '布局' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认布局' }));
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      theme: 'soft', sidebarWidth: 240, layout: 'stacked',
    });
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    expect(screen.getByRole('button', { name: '雾青' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('雾青实际样式与可读性', () => {
  it('显式覆盖所有已有主题 token，避免继承深色值', () => {
    const rules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    const customProperties = (style: CSSStyleDeclaration) =>
      Array.from({ length: style.length }, (_, index) => style[index]).filter(name => name.startsWith('--')).sort();
    const baseline = rules.find(rule => rule.selectorText.includes('data-theme=dark'))!;
    const soft = rules.find(rule => rule.selectorText === ':root[data-theme=soft]');
    expect(soft, '缺少独立雾青调色板').toBeDefined();
    expect(customProperties(soft!.style)).toEqual(customProperties(baseline.style));
    for (const name of customProperties(baseline.style)) expect(soft!.style.getPropertyValue(name).trim(), name).not.toBe('');
  });

  it('浅色外壳、较深侧栏和暖白正文具有层次，离开雾青恢复原调色板', () => {
    document.documentElement.dataset.theme = 'soft';
    expect(token('--bg')).toBe('#e8eceb');
    expect(token('--surface-subtle')).toBe('#dee6e3');
    expect(token('--panel')).toBe('#f7f8f4');
    expect(getComputedStyle(document.documentElement).colorScheme).toBe('light');
    document.documentElement.dataset.theme = 'dark';
    expect(token('--bg')).toBe('#191b22');
    document.documentElement.dataset.theme = 'light';
    expect(token('--bg')).toBe('#f3f5f7');
  });

  it('正文、提示、导航和按钮在实际表面上的文字对比度至少 4.5:1', () => {
    document.documentElement.dataset.theme = 'soft';
    const text = ['--text', '--text-secondary', '--muted', '--accent'];
    const surfaces = ['--bg', '--surface-subtle', '--panel', '--panel-raised', '--button-bg', '--button-hover', '--accent-soft'];
    for (const foreground of text) for (const background of surfaces) {
      expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of ['--nav-requests', '--nav-environments', '--nav-variables', '--nav-manage']) {
      expect(contrast(token(foreground), token('--bg')), foreground).toBeGreaterThanOrEqual(4.5);
    }
    for (const [foreground, background] of [
      ['--primary-text', '--primary-bg'], ['--primary-text', '--primary-hover'],
      ['--selection-text', '--accent-soft'], ['--success', '--success-bg'],
      ['--warning', '--warning-bg'], ['--danger', '--danger-bg'],
    ]) expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
    for (const background of ['--danger-solid', '--danger-hover']) {
      expect(contrast('#ffffff', token(background)), `白字 / ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('四类 JSON 值颜色互异，在正文、当前行和选择背景上的对比度至少 4.5:1', () => {
    document.documentElement.dataset.theme = 'soft';
    const syntax = ['--code-key', '--code-string', '--code-number', '--code-literal'];
    expect(new Set(syntax.map(token)).size).toBe(4);
    for (const foreground of [...syntax, '--code-text', '--code-gutter', '--code-punctuation']) {
      for (const background of ['--code-bg', '--code-active-line', '--code-selection']) {
        expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(token('--code-search-text'), token('--code-search-bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('焦点环和控件轮廓相对表面的对比度至少 3:1', () => {
    document.documentElement.dataset.theme = 'soft';
    for (const background of ['--bg', '--surface-subtle', '--panel', '--control-bg', '--button-bg', '--accent-soft']) {
      for (const foreground of ['--focus-ring', '--control-border']) {
        expect(contrast(token(foreground), token(background)), `${foreground} / ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
