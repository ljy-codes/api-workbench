import { createElement, StrictMode, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Preferences } from './preferences';

const storageKey = 'envdock.preferences.v1';
const defaults: Preferences = {
  theme: 'dark', sidebarCollapsed: false, layout: 'stacked',
  sidebarWidth: 240, editorHeight: 280, editorWidth: 500,
};

function mockSystemTheme(initialDark = false, legacy = false) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const add = vi.fn((_: string, listener: () => void) => listeners.add(listener));
  const remove = vi.fn((_: string, listener: () => void) => listeners.delete(listener));
  const media = {
    get matches() { return dark; },
    media: '(prefers-color-scheme: dark)',
    ...(legacy ? {
      addListener: vi.fn((listener: () => void) => listeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
    } : { addEventListener: add, removeEventListener: remove }),
  };
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    listeners, matchMedia, add, remove,
    change(nextDark: boolean) {
      dark = nextDark;
      act(() => { for (const listener of listeners) listener(); });
    },
  };
}

async function loadPreferences() {
  const lib = await import('./preferences');
  const { usePreferences } = await import('../hooks/usePreferences');
  return { ...lib, usePreferences };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  mockSystemTheme();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('本机偏好与启动主题', () => {
  it('缺少存储时在 React 渲染前同步应用深色，默认值符合接口约定', async () => {
    const { initializePreferences, usePreferences } = await loadPreferences();
    initializePreferences();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem(storageKey)).toBeNull();
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences).toEqual(defaults);
  });

  it.each(['{broken', 'null', '42', 'true', '"light"', '[]'])(
    '损坏或错误根类型 %s 回退默认值且不阻止启动',
    async raw => {
      localStorage.setItem(storageKey, raw);
      const { initializePreferences, usePreferences } = await loadPreferences();
      expect(() => initializePreferences()).not.toThrow();
      const { result } = renderHook(usePreferences);
      expect(result.current.preferences).toEqual(defaults);
    },
  );

  it('逐字段校验，保留有效字段、补齐缺省值并丢弃额外字段', async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      theme: 'light', sidebarCollapsed: 'false', layout: 'unknown',
      sidebarWidth: '300', editorHeight: null, editorWidth: 620, foreign: 'ignored',
    }));
    const { initializePreferences, usePreferences } = await loadPreferences();
    initializePreferences();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences).toEqual({ ...defaults, theme: 'light', editorWidth: 620 });
  });

  it.each([
    [{ sidebarWidth: -1, editorHeight: 0, editorWidth: -100 }, { sidebarWidth: 200, editorHeight: 160, editorWidth: 300 }],
    [{ sidebarWidth: 9999, editorHeight: 9999, editorWidth: 9999 }, { sidebarWidth: 420, editorHeight: 720, editorWidth: 900 }],
    [{ sidebarWidth: 250.7, editorHeight: 300.2, editorWidth: 555.6 }, { sidebarWidth: 251, editorHeight: 300, editorWidth: 556 }],
  ])('尺寸恢复限制在可操作范围且使用整数像素：%j', async (stored, expected) => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const { usePreferences } = await loadPreferences();
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences).toEqual({ ...defaults, ...expected });
  });

  it('不同 Hook 共享偏好，连续部分更新保留其他字段并即时应用、持久化', async () => {
    const { initializePreferences, usePreferences } = await loadPreferences();
    initializePreferences();
    const first = renderHook(usePreferences);
    const second = renderHook(usePreferences);
    const update = first.result.current.updatePreferences;
    act(() => {
      update({ theme: 'light', sidebarCollapsed: true });
      second.result.current.updatePreferences({ layout: 'side-by-side', editorWidth: 640 });
    });
    const expected = { ...defaults, theme: 'light', sidebarCollapsed: true, layout: 'side-by-side', editorWidth: 640 };
    expect(first.result.current.preferences).toEqual(expected);
    expect(second.result.current.preferences).toEqual(expected);
    expect(first.result.current.updatePreferences).toBe(update);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(expected);
    initializePreferences();
    expect(first.result.current.preferences).toEqual(expected);
  });

  it('更新时也归一非法枚举、非布尔及非有限数值，有限越界值进行裁剪', async () => {
    const { usePreferences } = await loadPreferences();
    const { result } = renderHook(usePreferences);
    act(() => result.current.updatePreferences({
      theme: 'sepia', layout: false, sidebarCollapsed: 1,
      sidebarWidth: NaN, editorHeight: Infinity, editorWidth: -1,
    } as unknown as Partial<Preferences>));
    expect(result.current.preferences).toEqual({ ...defaults, editorWidth: 300 });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ ...defaults, editorWidth: 300 });
  });

  it('localStorage 属性访问被拒绝时仍可启动、修改主题和布局', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    const { initializePreferences, usePreferences } = await loadPreferences();
    expect(() => initializePreferences()).not.toThrow();
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences).toEqual(defaults);
    expect(() => act(() => result.current.updatePreferences({ theme: 'light', layout: 'side-by-side' }))).not.toThrow();
    expect(result.current.preferences.layout).toBe('side-by-side');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('getItem 失败回退默认值，后续可正常保存', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('Read denied'); });
    const { initializePreferences, usePreferences } = await loadPreferences();
    expect(() => initializePreferences()).not.toThrow();
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences).toEqual(defaults);
    act(() => result.current.updatePreferences({ sidebarCollapsed: true }));
    expect(JSON.parse(localStorage.getItem(storageKey)!).sidebarCollapsed).toBe(true);
  });

  it('setItem 失败保留内存偏好和主题，存储恢复后可继续保存', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const { usePreferences } = await loadPreferences();
    const first = renderHook(usePreferences);
    expect(() => act(() => first.result.current.updatePreferences({ theme: 'light' }))).not.toThrow();
    expect(document.documentElement.style.colorScheme).toBe('light');
    first.unmount();
    const second = renderHook(usePreferences);
    expect(second.result.current.preferences.theme).toBe('light');
    act(() => second.result.current.updatePreferences({ editorHeight: 350 }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ ...defaults, theme: 'light', editorHeight: 350 });
  });

  it('新的应用实例完整恢复已保存的主题与布局尺寸', async () => {
    const first = await loadPreferences();
    const { result, unmount } = renderHook(first.usePreferences);
    const expected: Preferences = {
      theme: 'light', sidebarCollapsed: true, layout: 'side-by-side',
      sidebarWidth: 310, editorHeight: 440, editorWidth: 700,
    };
    act(() => result.current.updatePreferences(expected));
    unmount();
    vi.resetModules();
    const second = await loadPreferences();
    second.initializePreferences();
    expect(document.documentElement.dataset.theme).toBe('light');
    const restored = renderHook(second.usePreferences);
    expect(restored.result.current.preferences).toEqual(expected);
  });

  it('重复初始化及无变化更新保持快照稳定且不重复写存储', async () => {
    const system = mockSystemTheme(true);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { initializePreferences, usePreferences } = await loadPreferences();
    const { result } = renderHook(usePreferences);
    const snapshot = result.current.preferences;
    act(() => {
      initializePreferences();
      result.current.updatePreferences({});
      result.current.updatePreferences({ theme: 'dark' });
    });
    expect(result.current.preferences).toBe(snapshot);
    expect(write).not.toHaveBeenCalled();
    expect(system.matchMedia).not.toHaveBeenCalled();
    system.change(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('系统主题监听的生命周期', () => {
  it('启动时解析系统主题，系统色变只更新实际主题，不改写 system 偏好', async () => {
    const system = mockSystemTheme(true);
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'system' }));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { initializePreferences, usePreferences } = await loadPreferences();
    initializePreferences();
    expect(document.documentElement.dataset.theme).toBe('dark');
    initializePreferences();
    const { result, unmount } = renderHook(usePreferences);
    expect(system.listeners.size).toBe(1);
    system.change(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(result.current.preferences.theme).toBe('system');
    expect(write).not.toHaveBeenCalled();
    unmount();
    expect(system.listeners.size).toBe(0);
  });

  it('切换到固定主题后立即解除监听，系统变化不覆盖手动选择', async () => {
    const system = mockSystemTheme();
    const { usePreferences } = await loadPreferences();
    const { result } = renderHook(usePreferences);
    act(() => result.current.updatePreferences({ theme: 'system' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(system.listeners.size).toBe(1);
    act(() => result.current.updatePreferences({ theme: 'dark' }));
    expect(system.listeners.size).toBe(0);
    system.change(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(localStorage.getItem(storageKey)!).theme).toBe('dark');
  });

  it('多个订阅者共用一个监听，最后一个卸载时清理，重挂载重新读取系统状态', async () => {
    const system = mockSystemTheme();
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'system' }));
    const { usePreferences } = await loadPreferences();
    const first = renderHook(usePreferences);
    const second = renderHook(usePreferences);
    expect(system.listeners.size).toBe(1);
    first.unmount();
    expect(system.listeners.size).toBe(1);
    second.unmount();
    expect(system.listeners.size).toBe(0);
    system.change(true);
    const third = renderHook(usePreferences);
    expect(system.listeners.size).toBe(1);
    expect(document.documentElement.dataset.theme).toBe('dark');
    third.unmount();
    expect(system.listeners.size).toBe(0);
  });

  it('React StrictMode 重订阅不泄漏监听', async () => {
    const system = mockSystemTheme();
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'system' }));
    const { usePreferences } = await loadPreferences();
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);
    const { unmount } = renderHook(usePreferences, { wrapper });
    expect(system.listeners.size).toBe(1);
    system.change(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    unmount();
    expect(system.listeners.size).toBe(0);
  });

  it('兼容旧 WebView 的 addListener / removeListener', async () => {
    const system = mockSystemTheme(false, true);
    const { usePreferences } = await loadPreferences();
    const { result, unmount } = renderHook(usePreferences);
    act(() => result.current.updatePreferences({ theme: 'system' }));
    system.change(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    unmount();
    expect(system.listeners.size).toBe(0);
  });

  it.each(['missing', 'throws'])('matchMedia %s 时 system 安全回退深色', async kind => {
    vi.stubGlobal('matchMedia', kind === 'missing' ? undefined : () => { throw new Error('Unavailable'); });
    localStorage.setItem(storageKey, JSON.stringify({ theme: 'system' }));
    const { initializePreferences, usePreferences } = await loadPreferences();
    expect(() => initializePreferences()).not.toThrow();
    const { result } = renderHook(usePreferences);
    expect(result.current.preferences.theme).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
