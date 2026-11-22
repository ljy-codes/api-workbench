// Node 25 exposes experimental global storage objects without the Web Storage
// methods, which shadows jsdom's implementation in Vitest. Use a small,
// dedicated jsdom realm so Storage.prototype spies and both global access
// styles (`localStorage` and `window.localStorage`) keep the same in-memory store.
import { JSDOM } from 'jsdom';
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 15000 });

const storageWindow = new JSDOM('', { url: 'http://localhost' }).window;
const storageConstructor = storageWindow.Storage;
Object.defineProperty(globalThis, 'Storage', { configurable: true, value: storageConstructor });
Object.defineProperty(window, 'Storage', { configurable: true, value: storageConstructor });
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const storage = storageWindow[name];
  Object.defineProperty(window, name, {
    configurable: true,
    enumerable: true,
    get: () => storage,
  });
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}

// jsdom has no text geometry. Keep the real CodeMirror model, commands and input behavior.
Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => document.createElement('span').getClientRects() },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
});
