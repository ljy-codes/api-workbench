import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import CodeMirror, { Decoration, EditorView } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { codeFolding, foldEffect, foldedRanges, foldService, unfoldAll, unfoldEffect } from '@codemirror/language';
import { jsonFolds } from '../lib/json-folding';
import type { JsonRange } from '../lib/json-inspection';
import { editorTheme } from './editorTheme';

export interface BodyMatch { from: number; to: number }
export interface CodeEditorHandle {
  collapseAll: () => void;
  expandAll: () => void;
  revealRange: (range: JsonRange) => void;
}
const noMatches: BodyMatch[] = [];
function revealRange(view: EditorView, range: JsonRange) {
  const from = Math.max(0, Math.min(range.from, view.state.doc.length));
  const to = Math.max(from, Math.min(range.to, view.state.doc.length));
  const effects = [EditorView.scrollIntoView(from, { y: 'center' })];
  foldedRanges(view.state).between(0, view.state.doc.length, (start, end) => {
    if (start < to && end > from) effects.push(unfoldEffect.of({ from: start, to: end }));
  });
  view.dispatch({ effects, selection: { anchor: from, head: to } });
  view.focus();
}

const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string; isJson: boolean; disabled?: boolean; readOnly?: boolean; label?: string;
  matches?: BodyMatch[]; onChange?: (value: string) => void;
  reveal?: JsonRange; onSelectPosition?: (position: number) => void;
}>(function CodeEditor({
  value, isJson, disabled = false, readOnly = false, label = '请求正文', matches = noMatches, onChange, reveal, onSelectPosition,
}, ref) {
  const editor = useRef<EditorView | null>(null);
  const folds = useMemo(() => readOnly && isJson ? jsonFolds(value) : null, [value, isJson, readOnly]);
  useImperativeHandle(ref, () => ({
    collapseAll() {
      const view = editor.current;
      if (!view || !folds) return;
      // Keep an object root visible as a structural overview. Array roots fold
      // too, since thousands of collapsed array elements are still too much.
      const ranges = [...folds.values()]
        .filter(fold => fold.depth > 0 || fold.kind === '[')
        .sort((a, b) => a.from - b.from);
      unfoldAll(view);
      view.dispatch({
        effects: [...ranges.map(fold => foldEffect.of({ from: fold.from, to: fold.to })), EditorView.scrollIntoView(0)],
        selection: { anchor: 0 },
      });
    },
    expandAll() { if (editor.current) unfoldAll(editor.current); },
    revealRange(range) { if (editor.current) revealRange(editor.current, range); },
  }), [folds]);
  useEffect(() => { if (editor.current) unfoldAll(editor.current); }, [value, isJson]);
  useEffect(() => { if (editor.current && reveal) revealRange(editor.current, reveal); }, [reveal, value]);
  const extensions = useMemo(() => [
    ...(isJson ? [json()] : []),
    ...(folds ? [
      foldService.of((_state, from) => {
        const range = folds.get(from);
        return range ? { from: range.from, to: range.to } : null;
      }),
      codeFolding({
        preparePlaceholder: (state, range) => {
          const fold = folds.get(state.doc.lineAt(range.from).from);
          return fold ? `${fold.count} ${fold.kind === '[' ? '项' : '个字段'}` : '…';
        },
        placeholderDOM: (_view, onclick, summary: string) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'cm-foldPlaceholder';
          button.textContent = summary;
          button.title = '点击展开';
          button.setAttribute('aria-label', `展开 ${summary}`);
          button.onclick = onclick;
          return button;
        },
      }),
    ] : []),
    EditorView.contentAttributes.of({ 'aria-label': label, ...(readOnly ? { tabindex: '0' } : {}) }),
    EditorView.decorations.of(Decoration.set(matches.map(match =>
      Decoration.mark({ class: 'cm-searchMatch', tagName: 'mark' }).range(match.from, match.to),
    ))),
  ], [isJson, label, matches, readOnly, folds]);
  const basicSetup = useMemo(() => ({
    lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly,
    highlightActiveLineGutter: !readOnly, searchKeymap: !readOnly,
  }), [readOnly]);
  // A disabled fieldset does not disable contenteditable or CodeMirror commands.
  return <CodeMirror className="code-editor" aria-disabled={disabled} value={value}
    readOnly={disabled || readOnly} editable={!disabled && !readOnly} height="100%"
    onCreateEditor={view => { editor.current = view; if (reveal) revealRange(view, reveal); }}
    onUpdate={update => { if (update.selectionSet && readOnly && isJson) onSelectPosition?.(update.state.selection.main.from); }}
    theme={editorTheme} basicSetup={basicSetup} extensions={extensions} onChange={onChange} />;
});

export default CodeEditor;
