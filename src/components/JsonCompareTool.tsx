import { useState } from 'react';
import { ArrowLeftRight, GitCompare, ListCollapse, Trash2 } from 'lucide-react';
import { MAX_EXACT_JSON_INPUT_CHARS, parseExactJson } from '../lib/json-exact';
import { formatJson } from '../lib/json-format';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { ResponseDiff } from './ResponseDiff';
import './json-toolbox-panels.css';

interface CompareState {
  left: string;
  right: string;
  result: { baseline: unknown; current: unknown } | null;
  error: string;
  message: string;
  editorKey: number;
}

/** All drafts and parsed values belong to this mount; clear also destroys editor history. */
export function JsonCompareTool() {
  const [state, setState] = useState<CompareState>({
    left: '', right: '', result: null, error: '', message: '', editorKey: 0,
  });
  const [leftEditor, setLeftEditor] = useState<CodeEditorHandle | null>(null);
  const [rightEditor, setRightEditor] = useState<CodeEditorHandle | null>(null);
  const hasLeft = Boolean(state.left.trim());
  const hasRight = Boolean(state.right.trim());

  const edit = (side: 'left' | 'right', source: string) => {
    setState(previous => previous[side] === source ? previous : {
      ...previous, [side]: source, result: null, error: '',
      message: '内容已变化，请点击“开始对比”重新对比。',
    });
  };
  const compare = () => {
    let side = '左侧 JSON';
    try {
      // Parsing is deliberately restricted to this explicit action.
      const baseline = parseExactJson(state.left);
      side = '右侧 JSON';
      const current = parseExactJson(state.right);
      setState(previous => ({
        ...previous, result: { baseline, current }, error: '',
        message: '已完成对比，可在下方设置忽略字段和数组匹配方式。',
      }));
    } catch (error) {
      setState(previous => ({
        ...previous, result: null, message: '',
        error: `${side} 解析失败，两侧原文已保留。${error instanceof Error ? error.message : '请检查 JSON 格式。'}`,
      }));
    }
  };
  const format = () => {
    let side = '左侧 JSON';
    try {
      const prepare = (source: string, hasContent: boolean) => {
        if (!hasContent) return source;
        // Use the comparison parser's budgets and keep formatted output comparable.
        parseExactJson(source);
        return formatJson(source, { maxOutputChars: MAX_EXACT_JSON_INPUT_CHARS });
      };
      const left = prepare(state.left, hasLeft);
      side = '右侧 JSON';
      const right = prepare(state.right, hasRight);
      // Apply both together so a failure never partially replaces the drafts.
      leftEditor?.replaceValue(left);
      rightEditor?.replaceValue(right);
      setState(previous => ({
        ...previous, left, right, result: null, error: '',
        message: '已格式化两侧内容，请重新对比。',
      }));
    } catch (error) {
      setState(previous => ({
        ...previous, result: null, message: '',
        error: `${side} 格式化失败，两侧原文已保留。${error instanceof Error ? error.message : '请检查 JSON 格式。'}`,
      }));
    }
  };
  const swap = () => {
    leftEditor?.replaceValue(state.right);
    rightEditor?.replaceValue(state.left);
    setState(previous => ({
      ...previous, left: previous.right, right: previous.left, result: null, error: '',
      message: '已交换左右内容，请重新对比。',
    }));
  };
  const clear = () => setState(previous => ({
    left: '', right: '', result: null, error: '', message: '', editorKey: previous.editorKey + 1,
  }));

  return <section className="json-toolbox-panel json-compare-tool" aria-label="双栏 JSON 对比">
    <div className="json-toolbox-toolbar" role="group" aria-label="JSON 对比操作">
      <button type="button" aria-label="格式化两侧" disabled={!hasLeft && !hasRight} onClick={format}>
        <ListCollapse size={15} aria-hidden="true" />格式化两侧
      </button>
      <button type="button" aria-label="交换左右" disabled={!state.left && !state.right} onClick={swap}>
        <ArrowLeftRight size={15} aria-hidden="true" />交换左右
      </button>
      <button type="button" aria-label="清空两侧" disabled={!state.left && !state.right && !state.error} onClick={clear}>
        <Trash2 size={15} aria-hidden="true" />清空两侧
      </button>
    </div>
    <p className="json-toolbox-hint">以左侧为基准，点击“开始对比”后检查 JSON；保留 null 和数字精度。修改内容后请重新对比。</p>
    {state.error && <p className="json-toolbox-error" role="alert">{state.error}</p>}
    <div className="json-toolbox-editors">
      <section className="json-toolbox-column">
        <div className="json-toolbox-column-heading"><h3>左侧 JSON</h3><span>基准内容</span></div>
        <div className="json-toolbox-editor">
          <CodeEditor key={`left:${state.editorKey}`} ref={setLeftEditor} value={state.left} isJson label="左侧 JSON"
            onChange={source => edit('left', source)} />
        </div>
      </section>
      <section className="json-toolbox-column">
        <div className="json-toolbox-column-heading"><h3>右侧 JSON</h3><span>当前内容</span></div>
        <div className="json-toolbox-editor">
          <CodeEditor key={`right:${state.editorKey}`} ref={setRightEditor} value={state.right} isJson label="右侧 JSON"
            onChange={source => edit('right', source)} />
        </div>
      </section>
    </div>
    <div className="json-toolbox-toolbar json-toolbox-bottom">
      <button type="button" className="primary" aria-label="开始对比" disabled={!hasLeft || !hasRight} onClick={compare}>
        <GitCompare size={15} aria-hidden="true" />开始对比
      </button>
      <span role="status" aria-label="对比状态">{state.message || '内容仅在本窗口内存中处理'}</span>
    </div>
    {state.result !== null && <div className="json-toolbox-results" role="region" aria-label="JSON 对比结果" tabIndex={0}>
      <ResponseDiff baseline={state.result.baseline} current={state.result.current} />
    </div>}
  </section>;
}
