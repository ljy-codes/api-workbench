import { describe, expect, it } from 'vitest';
import { escapeJsonText, extractJsonValues, unescapeJsonText } from './json-toolbox';

describe('JSON string conversion', () => {
  it('escapes arbitrary text by exactly one JSON string layer', () => {
    expect(escapeJsonText('{"n":1}\n"\\\t')).toBe('"{\\"n\\":1}\\n\\"\\\\\\t"');
    expect(escapeJsonText('')).toBe('""');
    expect(escapeJsonText('null')).toBe('"null"');
    const text = '\u0000中文\r\n\\"';
    expect(unescapeJsonText(escapeJsonText(text))).toBe(text);
  });

  it('restores exactly one layer and keeps embedded JSON as text', () => {
    expect(unescapeJsonText('  "{\\"n\\":9223372036854775807}" \n')).toBe('{"n":9223372036854775807}');
    expect(unescapeJsonText('"\\\\n"')).toBe('\\n');
    expect(unescapeJsonText('"\\u4e2d\\n"')).toBe('中\n');
  });

  it.each(['{}', '[]', 'null', '1', 'true', "'text'", 'text', '"a",', '"\\x20"', '"bad\nstring"'])(
    'requires a complete, quoted JSON string: %j', source => {
      expect(() => unescapeJsonText(source)).toThrow();
    },
  );

  it('bounds source and encoded output before returning a result', () => {
    expect(() => escapeJsonText('x'.repeat(1_000_001))).toThrow(/字符|输入/);
    expect(() => unescapeJsonText(' '.repeat(1_000_001))).toThrow(/字符|输入/);
    expect(() => escapeJsonText('\u0000'.repeat(400_000))).toThrow(/输出|结果|字符/);
  });
});

describe('extractJsonValues', () => {
  it('returns a JSON array by default, keeping exact number text and nulls', () => {
    expect(extractJsonValues('{"rows":[{"id":9223372036854775807},{"id":1.234567890123456789},{"id":null}]}', '$.rows[*].id'))
      .toEqual({ text: '[\n  9223372036854775807,\n  1.234567890123456789,\n  null\n]', count: 3 });
  });

  it('extracts the root as one value and supports indexed and root-relative paths', () => {
    expect(extractJsonValues('[1,2]', '$', { format: 'lines' })).toEqual({ text: '[1,2]', count: 1 });
    expect(extractJsonValues('{"rows":[0,2.00]}', '.rows[1]', { format: 'lines' })).toEqual({ text: '2.00', count: 1 });
    expect(extractJsonValues('[true]', '[0]', { format: 'lines' })).toEqual({ text: 'true', count: 1 });
  });

  it('matches only array items and own object fields, respecting source object order', () => {
    const source = '{"2":"two","1":"one","__proto__":"own","constructor":"ctor"}';
    expect(extractJsonValues(source, '$[*]', { format: 'lines' }))
      .toEqual({ text: 'two\none\nown\nctor', count: 4 });
    expect(extractJsonValues('{}', '$.constructor')).toEqual({ text: '[]', count: 0 });
    expect(extractJsonValues('{}', '$.__proto__')).toEqual({ text: '[]', count: 0 });
    expect(extractJsonValues('{"__proto__":{"polluted":1}}', '$.__proto__.polluted', { format: 'lines' }))
      .toEqual({ text: '1', count: 1 });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('never exposes ExactNumber implementation fields or array length as JSON fields', () => {
    for (const path of ['$.raw', '$.canonical', '$[*]']) {
      expect(extractJsonValues('1', path)).toEqual({ text: '[]', count: 0 });
    }
    for (const path of ['$.length', '$["length"]', '$.constructor']) {
      expect(extractJsonValues('[1]', path)).toEqual({ text: '[]', count: 0 });
    }
  });

  it.each([
    ['$["a.b"]["x\\"y"]', '"quoted"'],
    ["$['a.b']['x\\'y']", '"apostrophe"'],
    ['$["a\\u002eb"]["\\\\"]', '"slash"'],
    ["$['a.b']['double\"key']", '"double"'],
    ['$[""]', '"empty"'],
    ['$.数据.状态', '"中文"'],
  ])('supports escaped quoted and Unicode fields: %s', (path, expected) => {
    const source = JSON.stringify({ 'a.b': { 'x"y': 'quoted', "x'y": 'apostrophe', '\\': 'slash', 'double"key': 'double' }, '': 'empty', 数据: { 状态: '中文' } });
    expect(extractJsonValues(source, path)).toEqual({ text: `[\n  ${expected}\n]`, count: 1 });
  });

  it('returns no matches for absent fields, wrong container types and out-of-range indexes', () => {
    for (const path of ['$.missing[*].id', '$.rows[9]', '$.rows.id', '$.text[*]', '$.value.id', '$.object[0]']) {
      expect(extractJsonValues('{"rows":[1],"text":"abc","value":null,"object":{"0":1}}', path))
        .toEqual({ text: '[]', count: 0 });
    }
  });

  it('walks multiple wildcards without modifying the source or matching missing properties', () => {
    const source = '{"groups":[{"rows":[{"id":1},{}]},{"rows":[{"id":2},{"id":3}]}]}';
    const before = source;
    expect(extractJsonValues(source, '$.groups[*].rows[*].id', { format: 'lines' }))
      .toEqual({ text: '1\n2\n3', count: 3 });
    expect(source).toBe(before);
    expect(extractJsonValues(source, '$.groups[*].rows[*].id', { format: 'lines' }).text).toBe('1\n2\n3');
  });

  it('writes lines using literal string text and compact JSON for every other value', () => {
    expect(extractJsonValues('["hello",1e400,null,true,{"2":1,"1":2},[3]]', '$[*]', { format: 'lines' }))
      .toEqual({ text: 'hello\n1e400\nnull\ntrue\n{"2":1,"1":2}\n[3]', count: 6 });
  });

  it('writes one CSV record with standard comma, quote and newline escaping', () => {
    expect(extractJsonValues('["plain","a,b","x\\"y","line\\nbreak",null,1.00,{"a":1}]', '$[*]', { format: 'csv' }))
      .toEqual({ text: 'plain,"a,b","x""y","line\nbreak",null,1.00,"{""a"":1}"', count: 7 });
    expect(extractJsonValues('[""]', '$[*]', { format: 'csv' })).toEqual({ text: '""', count: 1 });
  });

  it('only encodes SQL literals, doubling quotes in injection text without executing it', () => {
    const source = `["x'); DROP TABLE users; --",9223372036854775807,1e400,null,true,false,""]`;
    expect(extractJsonValues(source, '$[*]', { format: 'sql' })).toEqual({
      text: "IN ('x''); DROP TABLE users; --', 9223372036854775807, 1e400, NULL, TRUE, FALSE, '')",
      count: 7,
    });
  });

  it.each(['[{}]', '[[1]]'])('rejects composite SQL values rather than silently discarding them: %s', source => {
    expect(() => extractJsonValues(source, '$[*]', { format: 'sql' })).toThrow(/SQL|对象|数组|复合/);
  });

  it('deduplicates by type and exact numeric value, retaining the first original representation', () => {
    const source = '[1,1.0,1e0,"1",true,"true",null,null,-0,0,9223372036854775807,9223372036854775808,1.0000000000000000001]';
    expect(extractJsonValues(source, '$[*]', { format: 'lines', deduplicate: true })).toEqual({
      text: '1\n1\ntrue\ntrue\nnull\n-0\n9223372036854775807\n9223372036854775808\n1.0000000000000000001',
      count: 9,
    });
    expect(extractJsonValues('[1,1.0]', '$[*]', { format: 'lines' })).toEqual({ text: '1\n1.0', count: 2 });
  });

  it('deduplicates equivalent compound values using exact numbers and unordered object fields', () => {
    expect(extractJsonValues('[{"a":1,"b":2},{"b":2.0,"a":1e0},[1],[1.0],["1"]]', '$[*]', { format: 'lines', deduplicate: true }))
      .toEqual({ text: '{"a":1,"b":2}\n[1]\n["1"]', count: 3 });
  });

  it.each([
    '', 'rows.id', '$..id', '$.*', '$[?(@.id)]', '$[0:2]', '$[0,1]', '$[-1]',
    '$[01]', '$[1.0]', '$[9007199254740992]', '$.rows()', '$["x"', "$['bad\\x20']", '$[foo]', '$.x trailing',
  ])('strictly rejects unsupported or malformed path syntax: %j', path => {
    expect(() => extractJsonValues('{"rows":[]}', path)).toThrow(/路径/);
  });

  it('bounds path size, steps and matching results, including duplicates before deduplication', () => {
    expect(() => extractJsonValues('{}', '$.' + 'a'.repeat(4096))).toThrow(/路径/);
    expect(() => extractJsonValues('{}', '$' + '.a'.repeat(129))).toThrow(/路径/);
    const source = '[' + Array(10_001).fill('0').join(',') + ']';
    expect(() => extractJsonValues(source, '$[*]')).toThrow(/结果|匹配|数量/);
    expect(() => extractJsonValues(source, '$[*]', { deduplicate: true })).toThrow(/结果|匹配|数量/);
  });

  it('propagates invalid JSON and input budgets and rejects unknown output formats', () => {
    expect(() => extractJsonValues('[1,,]', '$')).toThrow();
    expect(() => extractJsonValues(' '.repeat(1_000_001), '$')).toThrow(/字符|输入/);
    expect(() => extractJsonValues('[]', '$', { format: 'xml' as 'json' })).toThrow(/格式/);
  });

  it('reports an empty result consistently for all output formats', () => {
    expect(extractJsonValues('{}', '$.missing', { format: 'lines' })).toEqual({ text: '', count: 0 });
    expect(extractJsonValues('{}', '$.missing', { format: 'csv' })).toEqual({ text: '', count: 0 });
    expect(extractJsonValues('{}', '$.missing', { format: 'sql' })).toEqual({ text: '', count: 0 });
  });

  it('does not generate a SQL fragment for an empty wildcard result', () => {
    expect(extractJsonValues('{"rows":[]}', '$.rows[*].id', { format: 'sql', deduplicate: true }))
      .toEqual({ text: '', count: 0 });
  });

  it('bounds indentation expansion while allowing the same bounded value as compact lines', () => {
    const source = '['.repeat(120) + '[' + Array(9000).fill('0').join(',') + ']' + ']'.repeat(120);
    expect(() => extractJsonValues(source, '$')).toThrow(/输出|结果|字符/);
    expect(extractJsonValues(source, '$', { format: 'lines', deduplicate: true })).toEqual({ text: source, count: 1 });
  });
});
