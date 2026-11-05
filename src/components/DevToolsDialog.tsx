import { useEffect, useId, useRef, useState } from 'react';
import { Braces, Copy, Trash2, Wrench } from 'lucide-react';
import {
  checkDevText, decodeBase64, decodeJwt, decodeUrl, encodeBase64, encodeUrl,
  isoToDate, timestampToDate, type DateResult, type TimestampUnit,
} from '../lib/dev-tools';
import { toSqlStringList } from '../lib/sql-list';
import CodeEditor from './CodeEditor';
import { Dialog } from './Dialog';
import './dev-tools.css';

const tools = [
  { key: 'url', title: 'URL 编解码', hint: '按 URL 组件编码（encodeURIComponent），每次解码一层；+ 保持为加号，不按表单空格处理。' },
  { key: 'base64', title: 'Base64 编解码', hint: '使用 UTF-8 文本与标准 Base64（+/ 字母表、完整 = 填充）；不接受空白、二进制或无效 UTF-8。' },
  { key: 'timestamp', title: 'Unix 时间戳', hint: '时间戳输入十进制整数，明确选择秒或毫秒。ISO 输入示例：2024-01-01T08:00:00.123+08:00 或 2024-01-01T00:00:00Z，必须带时区，最多三位毫秒。' },
  { key: 'jwt', title: 'JWT 结构查看', hint: '仅解码 Header / Payload；未验证签名，不用于登录或权限判断，也不判断是否过期。展示原始 JSON 文本，保留大整数；不支持加密 JWE。' },
  { key: 'sql-list', title: 'SQL 字符串列表', hint: '例如 "1","23" 或 1,2,3 → \'1\',\'23\' 或 \'1\',\'2\',\'3\'。支持逗号、中文逗号、换行和一维数组；保留前导零、顺序与重复项，忽略空白分隔项。双引号内容按 JSON 解码，单引号按 SQL 标准重复转义。' },
] as const;
type Tool = typeof tools[number]['key'];
interface Draft {
  tool: Tool;
  source: string;
  result: string | null;
  error: string;
  message: string;
  unit: TimestampUnit;
  editorKey: number;
}

function emptyDraft(tool: Tool, editorKey: number): Draft {
  return { tool, source: '', result: null, error: '', message: '', unit: 'seconds', editorKey };
}
function dateText(value: DateResult): string {
  return `Unix 秒：${value.seconds}\nUnix 毫秒：${value.milliseconds}\nUTC 时间：${value.utc}\n本地时间：${value.local}`;
}

/** All draft data and undo history are owned by this mount. No app state,
 * persistence, IPC or network dependencies. Clipboard writes require a click. */
export default function DevToolsDialog({ onClose, onOpenJson }: { onClose: () => void; onOpenJson: () => void }) {
  const id = useId();
  const [state, setState] = useState<Draft>(() => emptyDraft('url', 0));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const active = tools.find(item => item.key === state.tool)!;
  const edit = (source: string) => setState(previous => previous.source === source ? previous : {
    ...previous, source, result: null, error: '', message: '原文已变化，请重新转换。',
  });
  const show = (tool: Tool) => setState(previous => previous.tool === tool ? previous : emptyDraft(tool, previous.editorKey + 1));
  const clear = () => setState(previous => emptyDraft(previous.tool, previous.editorKey + 1));
  const convert = (action: 'encode' | 'decode' = 'decode') => {
    try {
      let result: string;
      switch (state.tool) {
        case 'url': result = action === 'encode' ? encodeUrl(state.source) : decodeUrl(state.source); break;
        case 'base64': result = action === 'encode' ? encodeBase64(state.source) : decodeBase64(state.source); break;
        case 'timestamp':
          result = dateText(action === 'encode' ? timestampToDate(state.source, state.unit) : isoToDate(state.source));
          break;
        case 'jwt': {
          const jwt = decodeJwt(state.source);
          result = `未验证签名 · 不用于登录或权限判断\n\nHeader（原始 JSON）\n${jwt.header}\n\nPayload（原始 JSON）\n${jwt.payload}`;
          break;
        }
        case 'sql-list': result = toSqlStringList(state.source); break;
      }
      checkDevText(result, '输出');
      setState(previous => ({ ...previous, result, error: '', message: '转换完成，可主动复制结果。' }));
    } catch (error) {
      setState(previous => ({
        ...previous, result: null, message: '',
        error: `处理失败，原文已保留。${error instanceof Error ? error.message : '请检查输入。'}`,
      }));
    }
  };
  const copy = async () => {
    const snapshot = state;
    if (snapshot.result === null) return;
    try {
      await navigator.clipboard.writeText(snapshot.result);
      if (alive.current) setState(previous => previous !== snapshot ? previous : { ...previous, error: '', message: '已复制结果' });
    } catch {
      if (alive.current) setState(previous => previous !== snapshot ? previous : {
        ...previous, error: '复制失败，请在结果区选择内容后复制。',
      });
    }
  };

  return <Dialog title="临时开发工具箱" onClose={onClose} className="dev-tools-dialog">
    <section className="dev-tools" aria-label="临时开发工具">
      <div className="dev-tools-intro">
        <div><Wrench size={19} aria-hidden="true" /><p>常用转换，粘贴即用。<span>仅在当前窗口内存中处理 · 不保存、不发送 · 关闭即清空</span></p></div>
        <button type="button" onClick={onOpenJson} aria-label="打开 JSON 工具"><Braces size={15} aria-hidden="true" />JSON 工具</button>
      </div>
      <div className="dev-tools-tabs" role="tablist" aria-label="开发工具类型">
        {tools.map((tool, index) => <button key={tool.key} type="button" role="tab" id={`${id}-${tool.key}`}
          aria-selected={state.tool === tool.key} tabIndex={state.tool === tool.key ? 0 : -1}
          aria-controls={`${id}-panel`} onClick={() => show(tool.key)} onKeyDown={event => {
            let next: number;
            if (event.key === 'ArrowRight') next = (index + 1) % tools.length;
            else if (event.key === 'ArrowLeft') next = (index + tools.length - 1) % tools.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tools.length - 1;
            else return;
            event.preventDefault();
            show(tools[next].key);
            document.getElementById(`${id}-${tools[next].key}`)?.focus();
          }}>{tool.title}</button>)}
      </div>
      <div className="dev-tools-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${state.tool}`}>
        <p className={`dev-tools-hint${state.tool === 'jwt' ? ' dev-tools-warning' : ''}`} id={`${id}-hint`}>{active.hint}</p>
        <div className="dev-tools-toolbar" role="group" aria-label={`${active.title}操作`}>
          {state.tool === 'timestamp' && <label className="dev-tools-unit">时间戳单位
            <select value={state.unit} onChange={event => {
              const unit = event.target.value as TimestampUnit;
              setState(previous => ({ ...previous, unit, result: null, error: '', message: '时间戳单位已变化，请重新转换。' }));
            }}><option value="seconds">秒（s）</option><option value="milliseconds">毫秒（ms）</option></select>
          </label>}
          {(state.tool === 'url' || state.tool === 'base64' || state.tool === 'timestamp') && <button type="button" className="primary" onClick={() => convert('encode')}>
            {state.tool === 'url' ? 'URL 编码' : state.tool === 'base64' ? 'Base64 编码' : '时间戳转日期'}
          </button>}
          <button type="button" className={state.tool === 'jwt' || state.tool === 'sql-list' ? 'primary' : undefined} onClick={() => convert('decode')}>
            {state.tool === 'url' ? 'URL 解码' : state.tool === 'base64' ? 'Base64 解码' : state.tool === 'timestamp' ? 'ISO 转时间戳' : state.tool === 'sql-list' ? '转为单引号列表' : '查看 JWT 结构'}
          </button>
          <button type="button" aria-label="清空工具" onClick={clear}>
            <Trash2 size={15} aria-hidden="true" />清空
          </button>
        </div>
        {state.error && <p className="dev-tools-error" role="alert">{state.error}</p>}
        <div className="dev-tools-editors" aria-describedby={`${id}-hint`} onKeyDownCapture={event => {
          // This toolbox uses Tab for focus navigation. Stop CodeMirror's
          // indent keymap from seeing it, while retaining native Tab behavior.
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
        }}>
          <section className="dev-tools-column" aria-label="输入区">
            <div className="dev-tools-column-heading"><h3>工具输入</h3><span>保留原文</span></div>
            <div className="dev-tools-editor">
              <CodeEditor key={`source:${state.editorKey}`} value={state.source} isJson={false} label="工具输入" onChange={edit} />
            </div>
          </section>
          <section className="dev-tools-column" aria-label="结果区">
            <div className="dev-tools-column-heading"><h3>工具结果</h3>
              <button type="button" aria-label="复制结果" disabled={state.result === null} onClick={() => void copy()}>
                <Copy size={15} aria-hidden="true" />复制结果
              </button>
            </div>
            <div className="dev-tools-editor">
              <CodeEditor key={`result:${state.editorKey}:${state.result === null ? 'empty' : 'ready'}`}
                value={state.result ?? ''} isJson={false} readOnly label="工具结果" />
            </div>
          </section>
        </div>
        <footer className="dev-tools-footer">
          <span role="status" aria-label="工具状态">{state.message || '切换工具清空草稿；修改输入或单位后需重新转换。'}</span>
          <span>输入 / 输出各限 1 MiB（UTF-8 字节）</span>
        </footer>
      </div>
    </section>
  </Dialog>;
}
