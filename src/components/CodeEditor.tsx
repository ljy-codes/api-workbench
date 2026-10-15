import { useMemo } from 'react';
import CodeMirror, { Decoration, EditorView } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { editorTheme } from './editorTheme';

export interface BodyMatch { from: number; to: number }
const noMatches: BodyMatch[] = [];

export default function CodeEditor({
  value, isJson, disabled = false, readOnly = false, label = '请求正文', matches = noMatches, onChange,
}: {
  value: string; isJson: boolean; disabled?: boolean; readOnly?: boolean; label?: string;
  matches?: BodyMatch[]; onChange?: (value: string) => void;
}) {
  const extensions = useMemo(() => [
    ...(isJson ? [json()] : []),
    EditorView.contentAttributes.of({ 'aria-label': label, ...(readOnly ? { tabindex: '0' } : {}) }),
    EditorView.decorations.of(Decoration.set(matches.map(match =>
      Decoration.mark({ class: 'cm-searchMatch', tagName: 'mark' }).range(match.from, match.to),
    ))),
  ], [isJson, label, matches, readOnly]);
  const basicSetup = useMemo(() => ({
    lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly,
    highlightActiveLineGutter: !readOnly, searchKeymap: !readOnly,
  }), [readOnly]);
  // A disabled fieldset does not disable contenteditable or CodeMirror commands.
  return <CodeMirror className="code-editor" aria-disabled={disabled} value={value}
    readOnly={disabled || readOnly} editable={!disabled && !readOnly} height="100%"
    theme={editorTheme} basicSetup={basicSetup} extensions={extensions} onChange={onChange} />;
}
