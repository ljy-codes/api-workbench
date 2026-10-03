import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

export default function CodeEditor({ value, isJson, disabled, onChange }: { value: string; isJson: boolean; disabled: boolean; onChange: (value: string) => void }) {
  // A disabled fieldset does not disable contenteditable or CodeMirror commands.
  return <CodeMirror aria-label="请求正文" aria-disabled={disabled} value={value} readOnly={disabled} editable={!disabled} height="210px" theme={oneDark} extensions={isJson ? [json()] : []} onChange={onChange} />;
}
