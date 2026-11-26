import { useState } from 'react';
import { ArrowLeftRight, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { escapeJsonText, unescapeJsonText } from '../lib/json-toolbox';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import './json-toolbox-panels.css';

interface StringState {
  source: string;
  result: string | null;
  error: string;
  message: string;
  editorKey: number;
}

export function JsonStringTool() {
  const [state, setState] = useState<StringState>({
    source: '', result: null, error: '', message: '', editorKey: 0,
  });
  const [sourceEditor, setSourceEditor] = useState<CodeEditorHandle | null>(null);

  const edit = (source: string) => setState(previous => previous.source === source ? previous : {
    ...previous, source, result: null, error: '',
    message: '原文已变化，请选择操作重新转换。',
  });
  const convert = (restore: boolean) => {
    try {
      const result = restore ? unescapeJsonText(state.source) : escapeJsonText(state.source);
      setState(previous => ({
        ...previous, result, error: '',
        message: restore ? '已还原一层 JSON 字符串' : '已转为带双引号的 JSON 字符串',
      }));
    } catch (error) {
      setState(previous => ({
        ...previous, result: null, message: '',
        error: `${restore ? '还原' : '转义'}失败，原文已保留。${error instanceof Error ? error.message : '请检查输入内容。'}`,
      }));
    }
  };
  const copy = async () => {
    const snapshot = state;
    if (snapshot.result === null) return;
    try {
      await navigator.clipboard.writeText(snapshot.result);
      // Ignore clipboard completions that belong to an edited or cleared draft.
      setState(previous => previous !== snapshot ? previous : {
        ...previous, error: '', message: '已复制转换结果',
      });
    } catch {
      setState(previous => previous !== snapshot ? previous : {
        ...previous, error: '复制失败，请在结果编辑区选择后复制。',
      });
    }
  };
  const continueWithResult = () => {
    if (state.result === null) return;
    sourceEditor?.replaceValue(state.result);
    setState(previous => previous.result === null ? previous : {
      ...previous, source: previous.result, result: null, error: '',
      message: '已将结果填入原文，请选择操作继续处理。',
    });
  };
  const clear = () => setState(previous => ({
    source: '', result: null, error: '', message: '', editorKey: previous.editorKey + 1,
  }));

  return <section className="json-toolbox-panel json-string-tool" aria-label="JSON 字符串转义还原">
    <div className="json-toolbox-toolbar" role="group" aria-label="JSON 字符串转换操作">
      <button type="button" className="primary" aria-label="转为字符串" onClick={() => convert(false)}>
        <ArrowLeftRight size={15} aria-hidden="true" />转为字符串
      </button>
      <button type="button" aria-label="还原字符串" disabled={!state.source.trim()} onClick={() => convert(true)}>
        <RotateCcw size={15} aria-hidden="true" />还原字符串
      </button>
      <button type="button" aria-label="清空转换" disabled={!state.source && state.result === null && !state.error} onClick={clear}>
        <Trash2 size={15} aria-hidden="true" />清空转换
      </button>
    </div>
    <p className="json-toolbox-hint">转为字符串会保留原文全部字符；还原要求输入带双引号的 JSON 字符串，每次仅还原一层，不自动猜测或修复格式。</p>
    {state.error && <p className="json-toolbox-error" role="alert">{state.error}</p>}
    <div className="json-toolbox-editors">
      <section className="json-toolbox-column">
        <div className="json-toolbox-column-heading"><h3>转义原文</h3><span>输入内容</span></div>
        <div className="json-toolbox-editor">
          <CodeEditor key={`source:${state.editorKey}`} ref={setSourceEditor} value={state.source} isJson={false}
            label="转义原文" onChange={edit} />
        </div>
      </section>
      <section className="json-toolbox-column">
        <div className="json-toolbox-column-heading"><h3>转义结果</h3><span>只读预览</span></div>
        <div className="json-toolbox-editor">
          <CodeEditor key={`result:${state.editorKey}:${state.result === null ? 'empty' : 'ready'}`}
            value={state.result ?? ''} isJson={false} readOnly label="转义结果" />
        </div>
      </section>
    </div>
    <div className="json-toolbox-toolbar" role="group" aria-label="转换结果操作">
      <button type="button" aria-label="复制转换结果" disabled={state.result === null} onClick={() => void copy()}>
        <Copy size={15} aria-hidden="true" />复制转换结果
      </button>
      <button type="button" disabled={state.result === null} onClick={continueWithResult}>用结果继续处理</button>
    </div>
    <footer className="json-toolbox-footer">
      <span role="status" aria-label="转换状态">{state.message || '内容仅在本窗口内存中处理'}</span>
      <span>{state.source.length.toLocaleString()} 字符 → {state.result?.length.toLocaleString() ?? '—'} 字符</span>
    </footer>
  </section>;
}
