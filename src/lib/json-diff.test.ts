import { describe, expect, it } from 'vitest';
import { compareJson } from './json-diff';

describe('compareJson', () => {
  it('reports additions, removals and scalar changes without mutating either input', () => {
    const baseline = Object.freeze({ kept: true, gone: null, count: 1 });
    const current = Object.freeze({ kept: true, count: 2, fresh: 'yes' });
    expect(compareJson(baseline, current)).toEqual({
      changes: [
        { path: '$.gone', kind: 'removed', before: null },
        { path: '$.count', kind: 'changed', before: 1, after: 2 },
        { path: '$.fresh', kind: 'added', after: 'yes' },
      ],
      truncated: false,
    });
  });

  it.each([
    [null, { value: 1 }],
    [[1], { 0: 1 }],
    [1, '1'],
    [false, null],
  ])('reports root type changes at $ (%j → %j)', (before, after) => {
    expect(compareJson(before, after)).toEqual({
      changes: [{ path: '$', kind: 'changed', before, after }], truncated: false,
    });
  });

  it('ignores object key order and keeps array order by default', () => {
    expect(compareJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({ changes: [], truncated: false });
    expect(compareJson([1, 2], [2, 1]).changes).toEqual([
      { path: '$[0]', kind: 'changed', before: 1, after: 2 },
      { path: '$[1]', kind: 'changed', before: 2, after: 1 },
    ]);
  });

  it('uses quoted bracket paths for punctuation, quotes, empty keys and numeric object keys', () => {
    expect(compareJson(
      { 'a.b': { 'x"y': 1 }, '': false, '0': 'old' },
      { 'a.b': { 'x"y': 2 }, '': true, '0': 'new' },
    ).changes.map(change => change.path)).toEqual(['$["0"]', '$["a.b"]["x\\"y"]', '$[""]']);
  });

  it('ignores a simple field name at any depth, including inside arrays', () => {
    expect(compareJson(
      { timestamp: 1, data: [{ timestamp: 2, value: 'old' }], nested: { timestamp: 3 } },
      { timestamp: 9, data: [{ timestamp: 8, value: 'new' }], nested: {} },
      { ignore: ['timestamp'] },
    )).toEqual({
      changes: [{ path: '$.data[0].value', kind: 'changed', before: 'old', after: 'new' }],
      truncated: false,
    });
  });

  it('ignores exact paths and their descendants without hiding the same field elsewhere', () => {
    expect(compareJson(
      { data: { timestamp: 1 }, timestamp: 1, 'a.b': [1, 2] },
      { data: { timestamp: 2 }, timestamp: 2, 'a.b': [3] },
      { ignore: ['$.data', '$["a.b"]'] },
    ).changes).toEqual([{ path: '$.timestamp', kind: 'changed', before: 1, after: 2 }]);
    expect(compareJson({ a: 1 }, null, { ignore: ['$'] })).toEqual({ changes: [], truncated: false });
  });

  it('uses the same Chinese paths as field inspection and accepts equivalent bracket paths', () => {
    const before = { 数据: { 状态: 1 }, 'a.b': 1 };
    const after = { 数据: { 状态: 2 }, 'a.b': 2 };
    expect(compareJson(before, after).changes[0].path).toBe('$.数据.状态');
    expect(compareJson(before, after, { ignore: ['$.数据.状态'] }).changes)
      .toEqual([{ path: '$["a.b"]', kind: 'changed', before: 1, after: 2 }]);
    expect(compareJson(before, after, { ignore: ['$["数据"]["状态"]', '$["a.b"]'] }))
      .toEqual({ changes: [], truncated: false });
  });

  it('treats __proto__ and constructor as own JSON keys and never changes prototypes', () => {
    const baseline = JSON.parse('{"__proto__":{"polluted":1},"constructor":1}');
    const current = JSON.parse('{"__proto__":{"polluted":2},"constructor":2}');
    expect(compareJson(baseline, current).changes).toEqual([
      { path: '$.__proto__.polluted', kind: 'changed', before: 1, after: 2 },
      { path: '$.constructor', kind: 'changed', before: 1, after: 2 },
    ]);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    const inherited = Object.create({ hidden: 'old' }) as Record<string, unknown>;
    inherited.visible = 1;
    expect(compareJson(inherited, { visible: 1, hidden: 'new' }).changes).toEqual([
      { path: '$.hidden', kind: 'added', after: 'new' },
    ]);
  });

  it('pairs unique object ids across reorder, with matched paths using the current index', () => {
    const baseline = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
    expect(compareJson(baseline, [baseline[1], baseline[0]], { matchById: true })).toEqual({
      changes: [], truncated: false,
    });
    expect(compareJson(baseline, [{ id: 'b', value: 3 }, baseline[0]], { matchById: true }).changes)
      .toEqual([{ path: '$[0].value', kind: 'changed', before: 2, after: 3 }]);
  });

  it('reports id additions and deletions and distinguishes string ids from numeric ids', () => {
    expect(compareJson(
      [{ id: 1, value: 'number' }, { id: '1', value: 'string' }],
      [{ id: '1', value: 'string' }, { id: 2, value: 'new' }],
      { matchById: true },
    ).changes).toEqual([
      { path: '$[0]', kind: 'removed', before: { id: 1, value: 'number' } },
      { path: '$[1]', kind: 'added', after: { id: 2, value: 'new' } },
    ]);
  });

  it.each([
    [[{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 2 }]],
    [[{ id: 1 }, null], [null, { id: 1 }]],
    [[{ id: 1 }, 'x'], ['x', { id: 1 }]],
    [[{ id: 1 }, { value: 2 }], [{ value: 2 }, { id: 1 }]],
    [[{ id: true }, { id: false }], [{ id: false }, { id: true }]],
  ])('falls back to indexes if either array is mixed or has invalid/duplicate ids', (before, after) => {
    expect(compareJson(before, after, { matchById: true })).toEqual(compareJson(before, after));
  });

  it('compares nulls and mixed arrays, including removed trailing values', () => {
    expect(compareJson([null, { a: 1 }, 7], [false, { a: 2 }]).changes).toEqual([
      { path: '$[0]', kind: 'changed', before: null, after: false },
      { path: '$[1].a', kind: 'changed', before: 1, after: 2 },
      { path: '$[2]', kind: 'removed', before: 7 },
    ]);
  });

  it('handles a deeply nested response without recursive stack overflow', () => {
    let baseline: unknown = 1;
    let current: unknown = 2;
    for (let depth = 0; depth < 12_000; depth++) {
      baseline = { next: baseline };
      current = { next: current };
    }
    const result = compareJson(baseline, current, { maxNodes: 15_000 });
    expect(result.truncated).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      path: `$${'.next'.repeat(12_000)}`, kind: 'changed', before: 1, after: 2,
    });
  });

  it('limits stored differences and reports whether additional differences were omitted', () => {
    expect(compareJson([1, 2, 3], [4, 5, 6], { maxChanges: 2 })).toEqual({
      changes: [
        { path: '$[0]', kind: 'changed', before: 1, after: 4 },
        { path: '$[1]', kind: 'changed', before: 2, after: 5 },
      ], truncated: true,
    });
    expect(compareJson([1, 2], [3, 2], { maxChanges: 1 }).truncated).toBe(false);
    expect(compareJson(1, 2, { maxChanges: 0 })).toEqual({ changes: [], truncated: true });
  });

  it('reports an incomplete scan even when no difference has been found yet', () => {
    const before = Array.from({ length: 100 }, (_, index) => index);
    const after = [...before];
    after[99] = -1;
    expect(compareJson(before, after, { maxNodes: 10 })).toEqual({ changes: [], truncated: true });
    expect(compareJson(1, 2, { maxNodes: 0 })).toEqual({ changes: [], truncated: true });
  });

  it('bounds id validation as well as traversal on huge arrays', () => {
    const baseline = Array.from({ length: 5000 }, (_, id) => ({ id }));
    const current = baseline.map(item => ({ ...item }));
    expect(compareJson(baseline, current, { matchById: true, maxNodes: 10 })).toEqual({
      changes: [], truncated: true,
    });
  });

  it('bounds cyclic unknown inputs and uses safe defaults for nonfinite limits', () => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    before.self = before;
    after.self = after;
    expect(compareJson(before, after, { maxNodes: 20 }).truncated).toBe(true);
    expect(compareJson(1, 2, { maxNodes: NaN, maxChanges: Infinity })).toEqual({
      changes: [{ path: '$', kind: 'changed', before: 1, after: 2 }], truncated: false,
    });
  });
});
