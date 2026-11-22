import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonCompareTool } from './JsonCompareTool';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function editor(label: '左侧 JSON' | '右侧 JSON') {
  return EditorView.findFromDOM(screen.getByLabelText(label))!;
}

function edit(label: '左侧 JSON' | '右侧 JSON', source: string) {
  const view = editor(label);
  act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }); });
  return view;
}

function compare(left: string, right: string) {
  render(<JsonCompareTool />);
  edit('左侧 JSON', left);
  edit('右侧 JSON', right);
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
}

it('为双栏提供可见标题和编辑器标签，空内容不触发比较', () => {
  render(<JsonCompareTool />);
  expect(screen.getByRole('heading', { name: '左侧 JSON' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '右侧 JSON' })).toBeInTheDocument();
  expect(editor('左侧 JSON').state.doc.toString()).toBe('');
  expect(editor('右侧 JSON').state.doc.toString()).toBe('');
  expect(screen.getByRole('button', { name: '开始对比' })).toBeDisabled();
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
});

it.each(['null', 'false', '"任意字符串"', '[1,null,{"a":true}]'])('支持根值 %s，输入时不提前比较', source => {
  render(<JsonCompareTool />);
  edit('左侧 JSON', source);
  edit('右侧 JSON', source);
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  expect(screen.getByText(/未发现差异/)).toBeInTheDocument();
});

it('对比超出安全整数和精确小数，展示完整数字原文', () => {
  compare(
    '{"id":9007199254740992,"amount":0.12345678901234567890}',
    '{"id":9007199254740993,"amount":0.12345678901234567891}',
  );
  const list = screen.getByRole('list', { name: 'JSON 差异' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  for (const value of ['9007199254740992', '9007199254740993', '0.12345678901234567890', '0.12345678901234567891']) {
    expect(within(list).getByText(value)).toBeInTheDocument();
  }
});

it('复用忽略字段和数组按精确 id 匹配', () => {
  compare(
    '[{"id":9007199254740992,"name":"甲","timestamp":1},{"id":9007199254740993,"name":"乙","timestamp":1}]',
    '[{"id":9007199254740993,"name":"乙","timestamp":2},{"id":9007199254740992,"name":"甲","timestamp":2}]',
  );
  fireEvent.change(screen.getByRole('textbox', { name: '忽略字段或路径' }), { target: { value: 'timestamp' } });
  fireEvent.click(screen.getByRole('button', { name: '应用忽略规则' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '数组按 id 匹配' }));
  expect(screen.getByText(/未发现差异/)).toBeInTheDocument();
});

it.each(['左侧 JSON', '右侧 JSON'] as const)('点击比较才报告%s错误，两侧原文都保留', label => {
  render(<JsonCompareTool />);
  edit('左侧 JSON', label === '左侧 JSON' ? '{"bad":1,,}' : '{"keep":null}');
  edit('右侧 JSON', label === '右侧 JSON' ? '{"bad":1,,}' : '{"keep":null}');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  const left = editor('左侧 JSON').state.doc.toString();
  const right = editor('右侧 JSON').state.doc.toString();
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  expect(screen.getByRole('alert')).toHaveTextContent(label);
  expect(screen.getByRole('alert')).toHaveTextContent('原文');
  expect(editor('左侧 JSON').state.doc.toString()).toBe(left);
  expect(editor('右侧 JSON').state.doc.toString()).toBe(right);
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
});

it.each(['左侧 JSON', '右侧 JSON'] as const)('编辑%s立即隐藏旧差异，提示重新对比', label => {
  compare('{"secret":"old"}', '{"secret":"new"}');
  const previousResult = screen.getByRole('region', { name: '响应 JSON 比较' });
  expect(within(previousResult).getByText('"old"')).toBeInTheDocument();
  edit(label, '{"pending":');
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
  expect(previousResult).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('对比状态')).toHaveTextContent('重新对比');
});

it('交换两侧后原比较失效，重新比较以交换后的左侧为基准', async () => {
  compare('"左内容"', '"右内容"');
  fireEvent.click(screen.getByRole('button', { name: '交换左右' }));
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(editor('左侧 JSON').state.doc.toString()).toBe('"右内容"');
    expect(editor('右侧 JSON').state.doc.toString()).toBe('"左内容"');
  });
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  const values = screen.getByRole('list', { name: 'JSON 差异' }).querySelectorAll('dd pre');
  expect([...values].map(value => value.textContent)).toEqual(['"右内容"', '"左内容"']);
});

it('格式化两侧保留数字字面量、null、原始键顺序和字符串转义', async () => {
  render(<JsonCompareTool />);
  edit('左侧 JSON', String.raw`{"10":9007199254740993,"2":0.12345678901234567890,"a":"\u4e2d","empty":null}`);
  edit('右侧 JSON', '[null,1e+100]');
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  await waitFor(() => {
    expect(editor('左侧 JSON').state.doc.toString()).toBe('{\n  "10": 9007199254740993,\n  "2": 0.12345678901234567890,\n  "a": "\\u4e2d",\n  "empty": null\n}');
    expect(editor('右侧 JSON').state.doc.toString()).toBe('[\n  null,\n  1e+100\n]');
  });
});

it('格式化任一侧失败时不覆盖另一侧原文，指出错误侧', () => {
  render(<JsonCompareTool />);
  edit('左侧 JSON', '{"ok":null}');
  edit('右侧 JSON', '{"bad":1,,}');
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  expect(screen.getByRole('alert')).toHaveTextContent('右侧 JSON');
  expect(editor('左侧 JSON').state.doc.toString()).toBe('{"ok":null}');
  expect(editor('右侧 JSON').state.doc.toString()).toBe('{"bad":1,,}');
});

it.each([4500, 9000])('展开 %s 项深层内容超出比较预算时，保留双栏原文且仍可比较', count => {
  const source = '['.repeat(120) + '[' + Array(count).fill('0').join(',') + ']' + ']'.repeat(120);
  compare(source, source);
  expect(screen.getByText(/未发现差异/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  expect(screen.getByRole('alert')).toHaveTextContent('左侧 JSON');
  expect(screen.getByRole('alert')).toHaveTextContent('1000000');
  expect(editor('左侧 JSON').state.doc.toString()).toBe(source);
  expect(editor('右侧 JSON').state.doc.toString()).toBe(source);
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  expect(screen.getByText(/未发现差异/)).toBeInTheDocument();
});

it('右侧展开超限时，不先替换左侧；格式化同样限制精确解析的嵌套深度', () => {
  render(<JsonCompareTool />);
  const source = '['.repeat(120) + '[' + Array(4500).fill('0').join(',') + ']' + ']'.repeat(120);
  edit('左侧 JSON', '{"ok":null}');
  edit('右侧 JSON', source);
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  expect(screen.getByRole('alert')).toHaveTextContent('右侧 JSON');
  expect(editor('左侧 JSON').state.doc.toString()).toBe('{"ok":null}');
  expect(editor('右侧 JSON').state.doc.toString()).toBe(source);
  const deep = '['.repeat(129) + '0' + ']'.repeat(129);
  edit('右侧 JSON', deep);
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  expect(screen.getByRole('alert')).toHaveTextContent('128');
  expect(editor('左侧 JSON').state.doc.toString()).toBe('{"ok":null}');
  expect(editor('右侧 JSON').state.doc.toString()).toBe(deep);
});

it('清空销毁双栏编辑器、撤销历史和比较选项，关闭重开也为空', () => {
  const mounted = render(<JsonCompareTool />);
  edit('左侧 JSON', '{"private":"left"}');
  edit('右侧 JSON', '{"private":"right"}');
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  fireEvent.change(screen.getByRole('textbox', { name: '忽略字段或路径' }), { target: { value: 'private' } });
  fireEvent.click(screen.getByRole('button', { name: '应用忽略规则' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '数组按 id 匹配' }));
  const left = editor('左侧 JSON');
  const right = editor('右侧 JSON');
  fireEvent.click(screen.getByRole('button', { name: '清空两侧' }));
  expect(editor('左侧 JSON')).not.toBe(left);
  expect(editor('右侧 JSON')).not.toBe(right);
  for (const label of ['左侧 JSON', '右侧 JSON'] as const) {
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'z', ctrlKey: true });
    expect(editor(label).state.doc.toString()).toBe('');
  }
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
  edit('左侧 JSON', '{"private":1}');
  edit('右侧 JSON', '{"private":2}');
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  expect(screen.getByRole('textbox', { name: '忽略字段或路径' })).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: '数组按 id 匹配' })).not.toBeChecked();
  mounted.unmount();
  render(<JsonCompareTool />);
  expect(editor('左侧 JSON').state.doc.toString()).toBe('');
  expect(editor('右侧 JSON').state.doc.toString()).toBe('');
  expect(screen.queryByRole('region', { name: '响应 JSON 比较' })).not.toBeInTheDocument();
});

it('编辑、格式化、比较及清空均不写浏览器存储或发送网络请求', () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
  compare('{"temporarySecret":1}', '{"temporarySecret":2}');
  fireEvent.click(screen.getByRole('button', { name: '格式化两侧' }));
  fireEvent.click(screen.getByRole('button', { name: '开始对比' }));
  fireEvent.click(screen.getByRole('button', { name: '清空两侧' }));
  expect(storage).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
});
