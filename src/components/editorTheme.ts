import { EditorView } from '@uiw/react-codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, class: 'cm-json-key' },
  { tag: tags.string, class: 'cm-json-string' },
  { tag: tags.number, class: 'cm-json-number' },
  { tag: [tags.bool, tags.null], class: 'cm-json-literal' },
  { tag: [tags.punctuation, tags.bracket], class: 'cm-json-punctuation' },
]);

export const editorTheme = [
  EditorView.theme({
    '&': { color: 'var(--code-text)', backgroundColor: 'var(--code-bg)' },
    '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 10px' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--code-gutter)', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--code-active-line)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-raised)', color: 'var(--muted)', borderColor: 'var(--border)' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#536a9155' },
    '.cm-searchMatch': { backgroundColor: '#e5b567', color: '#171b25', borderRadius: '2px' },
  }, { dark: true }),
  syntaxHighlighting(jsonHighlightStyle),
];
