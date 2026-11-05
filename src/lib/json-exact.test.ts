import { describe, expect, it } from 'vitest';
import { ExactNumber, isExactNumber, parseExactJson, stringifyExactJson } from './json-exact';

describe('exact JSON', () => {
  it('keeps adjacent long integers and precise decimals distinct without Number conversion', () => {
    const source = '[9223372036854775807,9223372036854775808,1.234567890123456789,1.234567890123456788,1e400]';
    const values = parseExactJson(source) as ExactNumber[];
    expect(values.every(isExactNumber)).toBe(true);
    expect(values[0].canonical).not.toBe(values[1].canonical);
    expect(values[2].canonical).not.toBe(values[3].canonical);
    expect(stringifyExactJson(values, true)).toBe(source);
  });

  it.each([
    ['1', '1.0', '1e0', '10e-1', '0.01e2'],
    ['-12.30', '-123e-1', '-0.123E+2'],
    ['0', '-0', '0.000e999999999999999999999999', '-0e-99999999999999999999999'],
    ['1000e999999999999999999997', '1e1000000000000000000000'],
    ['1e-1000000000000000000000', '10e-1000000000000000000001'],
  ])('normalizes mathematically equal numbers: %s', (...raw) => {
    expect(new Set(raw.map(value => new ExactNumber(value).canonical)).size).toBe(1);
  });

  it('does not expand enormous positive or negative exponents', () => {
    const positive = new ExactNumber('1e9999999999999999999999999999999999999');
    const negative = new ExactNumber('1e-9999999999999999999999999999999999999');
    expect(positive.canonical.length).toBeLessThan(80);
    expect(negative.canonical.length).toBeLessThan(80);
    expect(positive.canonical).not.toBe(negative.canonical);
    expect(stringifyExactJson([positive, negative], true))
      .toBe('[1e9999999999999999999999999999999999999,1e-9999999999999999999999999999999999999]');
  });

  it.each(['', '+1', '01', '-01', '.1', '1.', '1e', 'NaN', 'Infinity', ' 1', '1 ', '1\n', '1\r\n', '1\u2028'])(
    'rejects an invalid ExactNumber token: %j', raw => {
      expect(() => new ExactNumber(raw)).toThrow();
    },
  );

  it('does not mistake an arbitrary object or a native number for ExactNumber', () => {
    expect(isExactNumber({ raw: '1', canonical: '1e0' })).toBe(false);
    expect(isExactNumber(1)).toBe(false);
    expect(isExactNumber(null)).toBe(false);
    expect(isExactNumber(new ExactNumber('1'))).toBe(true);
  });

  it('keeps original key order including integer keys and decodes escaped keys safely', () => {
    const source = String.raw`{"2":"two","1":"one","a\u002eb":{"x\"y":"\u4e2d\n"},"0":0}`;
    const value = parseExactJson(source) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['2', '1', 'a.b', '0']);
    expect((value['a.b'] as Record<string, unknown>)['x"y']).toBe('中\n');
    expect(stringifyExactJson(value, true)).toBe(source);
    expect(stringifyExactJson(parseExactJson(stringifyExactJson(value)), true)).toBe(source);
  });

  it('parses prototype keys as own properties on objects with a null prototype', () => {
    const value = parseExactJson('{"__proto__":{"polluted":true},"constructor":{"prototype":null},"toString":1}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value.__proto__)).toBeNull();
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(stringifyExactJson(value, true))
      .toBe('{"__proto__":{"polluted":true},"constructor":{"prototype":null},"toString":1}');
  });

  it('keeps the first key position and the last value for duplicate JSON keys', () => {
    const value = parseExactJson('{"2":1,"1":2,"2":3}');
    expect(stringifyExactJson(value, true)).toBe('{"2":3,"1":2}');
  });

  it('accepts only trailing commas after real object members or array values', () => {
    const value = parseExactJson('{"text":"a,} b,] \\"c,}\\"","items":[1,{"a":null,},null,],}');
    expect(stringifyExactJson(value, true)).toBe('{"text":"a,} b,] \\"c,}\\"","items":[1,{"a":null},null]}');
  });

  it.each([
    '', ' ', '[,]', '{,}', '[1,,]', '{"a":1,,}', '{"a":,}', '{"a":1 "b":2}',
    '{"a":undefined}', '{/*comment*/"a":1}', '{"a":"unterminated}', '[01]',
    'true false', '1e', '+1', 'NaN', 'Infinity', '"\\x20"', '"\\u123x"', '"line\nbreak"', '\uFEFF{}',
  ])('rejects invalid JSON without guessing a repair: %j', source => {
    expect(() => parseExactJson(source)).toThrow();
  });

  it('supports root scalars, empty containers and the existing two-space pretty format', () => {
    expect(stringifyExactJson(parseExactJson('{"user":null,"data":[1,true,{}]}')))
      .toBe('{\n  "user": null,\n  "data": [\n    1,\n    true,\n    {}\n  ]\n}');
    for (const source of ['null', 'true', 'false', '"hello"', '[]', '{}', '-0.00']) {
      expect(stringifyExactJson(parseExactJson(source), true)).toBe(source);
    }
  });

  it('does not mutate frozen parsed objects while stringifying', () => {
    const value = parseExactJson('{"2":1,"1":{"n":2.00}}') as Record<string, unknown>;
    Object.freeze(value['1']);
    Object.freeze(value);
    expect(stringifyExactJson(value, true)).toBe('{"2":1,"1":{"n":2.00}}');
  });

  it('stringifies ordinary JSON values without invoking custom serialization hooks', () => {
    expect(stringifyExactJson({ value: 1, list: [true, 'text', null] }, true))
      .toBe('{"value":1,"list":[true,"text",null]}');
    expect(() => stringifyExactJson({ toJSON() { throw new Error('hook ran'); } })).toThrow(/JSON|类型/);
  });

  it.each([undefined, NaN, Infinity, 1n, Symbol('x'), () => 1])('rejects unsupported output values: %s', value => {
    expect(() => stringifyExactJson(value)).toThrow();
  });

  it('bounds input characters, nesting and parsed nodes with actionable errors', () => {
    expect(() => parseExactJson(' '.repeat(1_000_001))).toThrow(/字符|输入/);
    expect(() => parseExactJson('['.repeat(129) + '0' + ']'.repeat(129))).toThrow(/嵌套|深度/);
    expect(() => parseExactJson('[' + Array(50_001).fill('0').join(',') + ']')).toThrow(/节点/);
    expect(() => parseExactJson('1'.repeat(4097))).toThrow(/数字|数值/);
  });

  it('bounds output size, depth, nodes and cycles instead of returning a partial document', () => {
    expect(() => stringifyExactJson('x'.repeat(2_000_001))).toThrow(/输出|结果|字符/);
    let deep: unknown = 0;
    for (let i = 0; i < 129; i++) deep = [deep];
    expect(() => stringifyExactJson(deep)).toThrow(/嵌套|深度/);
    expect(() => stringifyExactJson(Array(50_001).fill(0))).toThrow(/节点/);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => stringifyExactJson(cyclic)).toThrow(/循环/);
  });

  it('distinguishes a shared subtree from a cycle', () => {
    const child = parseExactJson('{"id":9223372036854775807}');
    expect(stringifyExactJson([child, child], true))
      .toBe('[{"id":9223372036854775807},{"id":9223372036854775807}]');
  });
});
