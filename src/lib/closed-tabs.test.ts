import { describe, expect, it } from 'vitest';
import {
  addClosedTabs,
  discardClosedTab,
  nextClosedTab,
  removeInvalidClosedTabs,
  type ClosedTab,
} from './closed-tabs';

const tab = (requestId: string, index: number, projectId = 'project-a'): ClosedTab => ({ projectId, requestId, index });

describe('closed tabs', () => {
  it('按关闭顺序压入栈并最多保留 20 条', () => {
    const entries = addClosedTabs([], Array.from({ length: 21 }, (_, index) => tab(`r-${index}`, index)));

    expect(entries).toHaveLength(20);
    expect(entries[0]).toEqual(tab('r-20', 20));
    expect(entries.at(-1)).toEqual(tab('r-1', 1));
  });

  it('只恢复当前项目最近一条，并移除已取出的记录', () => {
    const entries = [
      tab('other', 0, 'project-b'),
      tab('latest', 2),
      tab('old', 1),
    ];

    expect(nextClosedTab(entries, 'project-a')).toEqual({
      entry: tab('latest', 2),
      rest: [tab('other', 0, 'project-b'), tab('old', 1)],
    });
  });

  it('可以清理重复打开的接口和已删除的接口，同时保留其他项目的记录', () => {
    const entries = [
      tab('keep', 0),
      tab('opened', 1),
      tab('deleted', 2),
      tab('foreign', 3, 'project-b'),
    ];

    expect(removeInvalidClosedTabs(entries, {
      projectId: 'project-a',
      requestIds: new Set(['keep', 'opened']),
      openTabs: new Set(['opened']),
    })).toEqual([tab('keep', 0), tab('foreign', 3, 'project-b')]);
  });

  it('主动打开接口时可以移除对应恢复记录', () => {
    const entries = [tab('keep', 0), tab('opened', 1)];
    expect(discardClosedTab(entries, 'project-a', 'opened')).toEqual([tab('keep', 0)]);
  });
});
