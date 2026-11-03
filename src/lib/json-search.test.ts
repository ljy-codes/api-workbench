import { expect, it } from 'vitest';
import { findJsonText } from './json-search';

it('按普通文本搜索，忽略大小写且支持 JSON 中的特殊字符', () => {
  expect(findJsonText('{"Name":"a.*[b]","name":"a.*[b]"}', 'a.*[b]').matches).toEqual([
    { from: 9, to: 15 }, { from: 25, to: 31 },
  ]);
  expect(findJsonText('Name name NAME', 'name').matches).toHaveLength(3);
  expect(findJsonText('{"a":1}', '').matches).toEqual([]);
});

it('大文本限制高亮数量，并仅在确有更多结果时提示截断', () => {
  expect(findJsonText('a'.repeat(1000), 'a').capped).toBe(false);
  const result = findJsonText('a'.repeat(1001), 'a');
  expect(result.matches).toHaveLength(1000);
  expect(result.capped).toBe(true);
});
