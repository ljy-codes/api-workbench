import { expect, it } from 'vitest';
import { jsonFolds } from './json-folding';

it('空容器和 JSON 标量不生成无内容的折叠区域', () => {
  for (const value of ['{}', '[]', 'null', '42', '"string"']) {
    expect(jsonFolds(value).size).toBe(0);
  }
  const folds = [...jsonFolds(JSON.stringify({ array: [], object: {}, text: '' }, null, 2)).values()];
  expect(folds).toHaveLength(1);
  expect(folds[0].count).toBe(3);
});

it('中文、表情和转义反斜线不影响实际文档坐标及直接子项计数', () => {
  const value = JSON.stringify({ '字段😀': ['\\\\', '"quoted"', '中文', { 'a,b': true }] }, null, 2);
  const fold = [...jsonFolds(value).values()].find(f => f.kind === '[')!;
  expect(JSON.parse(value.slice(fold.from - 1, fold.to + 1))).toEqual(JSON.parse(value)['字段😀']);
  expect(fold.count).toBe(4);
  expect([...jsonFolds(value).values()].find(f => f.depth === 0)?.count).toBe(1);
});

it('深层 JSON 用非递归扫描，不受调用栈深度限制', () => {
  const depth = 12000;
  const folds = jsonFolds('[\n'.repeat(depth) + '0' + '\n]'.repeat(depth));
  expect(folds.size).toBe(depth);
  expect(folds.get(0)).toMatchObject({ kind: '[', depth: 0, count: 1 });
});

it('折叠扫描忽略注释中的括号、逗号和字符串标记', () => {
  const value = `{
  // "ignored": [1, 2, 3],
  "items": [
    1,
    /* { "ignored": true } */
    2
  ]
}`;
  const folds = [...jsonFolds(value).values()];
  expect(folds).toHaveLength(2);
  expect(folds.find(fold => fold.kind === '[')?.count).toBe(2);
  expect(folds.find(fold => fold.depth === 0)?.count).toBe(1);
});
