// jsdom has no text geometry. Keep the real CodeMirror model, commands and input behavior.
Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => document.createElement('span').getClientRects() },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
});
