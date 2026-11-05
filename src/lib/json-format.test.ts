import { describe, expect, it } from 'vitest';
import { formatJson } from './json-format';

describe('JSON 格式化', () => {
  it('默认保留 null，支持展开及压缩成一行', () => {
    expect(formatJson('{"user":null,"data":[1,true,{}]}')).toBe('{\n  "user": null,\n  "data": [\n    1,\n    true,\n    {}\n  ]\n}');
    expect(formatJson('{\n "user": null, "data": [1, true, {}]\n}', { compact: true })).toBe('{"user":null,"data":[1,true,{}]}');
  });

  it('递归移除对象 null 字段，重排逗号但保留数组位置及其他假值', () => {
    const source = '{"first":null,"nested":{"a":null,"b":2,"last":null},"items":[null,{"n":null,"v":0}],"flag":false,"text":"","last":null}';
    expect(formatJson(source, { removeNull: true, compact: true })).toBe('{"nested":{"b":2},"items":[null,{"v":0}],"flag":false,"text":""}');
    expect(formatJson('{"only":null}', { removeNull: true })).toBe('{}');
    expect(formatJson('null', { removeNull: true })).toBe('null');
  });

  it('删除对象与数组的尾随逗号，字符串中的逗号和括号保持原样', () => {
    const source = '{"text":"a,} b,] \\"c,}\\"","items":[1,{"a":null,},null,],}';
    expect(formatJson(source, { compact: true })).toBe('{"text":"a,} b,] \\"c,}\\"","items":[1,{"a":null},null]}');
    expect(formatJson(source, { removeNull: true, compact: true })).toBe('{"text":"a,} b,] \\"c,}\\"","items":[1,{},null]}');
  });

  it('大整数、精确小数、键顺序及转义内容不被格式化改写', () => {
    const source = '{"id":9223372036854775807,"decimal":1.234567890123456789,"scientific":1e400,"2":"b","1":"a","escaped":"\\u4e2d\\n","__proto__":null}';
    expect(formatJson(formatJson(source), { compact: true })).toBe(source);
    expect(formatJson('{"id":9223372036854775807,"drop":null,}', { removeNull: true, compact: true })).toBe('{"id":9223372036854775807}');
  });

  it('可选输出预算在展开与压缩时均生效，恰好等于上限仍可完整返回', () => {
    expect(formatJson('[1]', { maxOutputChars: 7 })).toBe('[\n  1\n]');
    expect(() => formatJson('[1]', { maxOutputChars: 6 })).toThrow(/6/);
    expect(formatJson('[1]', { compact: true, maxOutputChars: 3 })).toBe('[1]');
    expect(() => formatJson('[1]', { compact: true, maxOutputChars: 2 })).toThrow(/2/);
  });

  it.each(['[,]', '{,}', '[1,,]', '{"a":1,,}', '{"a":,}', '{"a":1 "b":2}', '{"a":undefined}', '{/*comment*/"a":1}', '{"a":"unterminated}', ''])('拒绝不明确的错误，不猜测修复内容：%s', source => {
    expect(() => formatJson(source)).toThrow();
  });
});
