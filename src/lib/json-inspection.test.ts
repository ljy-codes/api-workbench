import { describe, expect, it } from 'vitest';
import { arrayColumns, arrayPaths, cellValue, formatJsonPath, jsonNodeAt, jsonRange, parseJsonPath, resolveJsonPath } from './json-inspection';

describe('JSON 字段路径', () => {
  it('支持根、数组、中文及带转义的特殊键，格式化后可逆', () => {
    const path = ['data', 'a.b', 12, '引号"\\', ''];
    expect(parseJsonPath(formatJsonPath(path))).toEqual(path);
    expect(parseJsonPath('data.rows[12].name')).toEqual(['data', 'rows', 12, 'name']);
    expect(parseJsonPath('$')).toEqual([]);
  });
  it.each(['$.data[*]', '$.data[-1]', '$.data[1.2]', '$..data', '$.data[', '$.data.__proto__()', '$.data ' + 'junk'])('拒绝表达式和错误路径 %s', text => {
    expect(parseJsonPath(text)).toBeNull();
  });
  it('仅访问自身字段，能读取显式的 __proto__，区分缺失和 null', () => {
    const value = JSON.parse('{"data":null,"__proto__":{"x":1}}');
    expect(resolveJsonPath(value, ['data'])).toEqual({ found: true, value: null });
    expect(resolveJsonPath(value, ['toString'])).toEqual({ found: false });
    expect(resolveJsonPath(value, ['__proto__', 'x'])).toEqual({ found: true, value: 1 });
    expect(resolveJsonPath([3], ['length'])).toEqual({ found: false });
  });
});

describe('格式化 JSON 字段位置', () => {
  const value = { 'a.b': ['x,{}[]', { '引号"': true }], empty: null };
  const text = JSON.stringify(value, null, 2);
  it('定位字符串及嵌套对象，范围可复制正确 JSON，键中的括号不干扰', () => {
    const range = jsonRange(text, ['a.b', 1]);
    expect(JSON.parse(text.slice(range!.from, range!.to))).toEqual({ '引号"': true });
    expect(jsonRange(text, ['missing'])).toBeNull();
  });
  it('点击键或值能获得准确路径，括号选中对应容器', () => {
    const node = jsonNodeAt(text, text.indexOf('引号'));
    expect(node?.path).toEqual(['a.b', 1, '引号"']);
    expect(text.slice(node!.from, node!.to)).toBe('true');
    expect(jsonNodeAt(text, text.indexOf('['))?.path).toEqual(['a.b']);
    expect(jsonNodeAt(text, text.lastIndexOf('}'))?.path).toEqual([]);
  });
  it('深层嵌套与 7525 项数组不依赖递归栈', () => {
    const large = JSON.stringify({ rows: Array.from({ length: 7525 }, (_, id) => ({ id })) }, null, 2);
    const target = jsonRange(large, ['rows', 7524, 'id']);
    expect(large.slice(target!.from, target!.to)).toBe('7524');
    const deep = '['.repeat(2500) + '1' + ']'.repeat(2500);
    expect(jsonNodeAt(deep, 2500)?.path).toHaveLength(2500);
  });
});

describe('数组表格模型', () => {
  it('发现不同层次数组，限制遍历并报告截取', () => {
    const found = arrayPaths({ data: { list: [{ tags: ['x'] }] }, more: [1, 2] });
    expect(found.paths.map(formatJsonPath)).toEqual(['$.data.list', '$.data.list[0].tags', '$.more']);
    expect(arrayPaths({ a: [1], b: [2] }, 1).truncated).toBe(true);
  });
  it('对象列汇总包含缺失、特殊字段及混合数组，标量使用值列', () => {
    expect(arrayColumns([{ id: 1 }, { name: 'a' }]).keys).toEqual(['id', 'name']);
    expect(arrayColumns([1, true, null]).scalar).toBe(true);
    expect(arrayColumns([1, { id: 2 }]).scalar).toBe(true);
    expect(cellValue({ id: 2 }, 'id', false)).toEqual({ found: true, value: 2 });
    expect(cellValue({}, 'toString', false)).toEqual({ found: false });
  });
});
