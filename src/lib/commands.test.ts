import { describe, expect, it } from 'vitest';
import { COMMANDS, commandGroups, formatShortcut, type CommandId } from './commands';

describe('workspace commands', () => {
  it('命令 ID 唯一并覆盖工作台确认的动作', () => {
    const ids = COMMANDS.map(command => command.id);
    const expected: CommandId[] = [
      'save',
      'restore-closed-tab',
      'open-temporary',
      'open-json-tools',
      'open-dev-tools',
      'open-history',
      'open-settings',
      'toggle-layout',
      'toggle-sidebar',
      'open-shortcuts',
    ];

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expected);
  });

  it('快捷键显示统一处理 mac 与 windows 文案', () => {
    expect(formatShortcut(['Mod', 'Shift', 'P'], false)).toBe('Ctrl ⇧ P');
    expect(formatShortcut(['Mod', 'Shift', 'P'], true)).toBe('⌘ ⇧ P');
  });

  it('快捷键总览可以按分组读取并保持命令定义顺序', () => {
    const groups = commandGroups(COMMANDS);
    expect(groups.map(group => group.label)).toEqual(['工作台', '标签', '请求与响应', '工具']);
    expect(groups.flatMap(group => group.commands).map(command => command.id)).toEqual([
      'save',
      'open-temporary',
      'toggle-layout',
      'toggle-sidebar',
      'restore-closed-tab',
      'open-history',
      'open-json-tools',
      'open-dev-tools',
      'open-settings',
      'open-shortcuts',
    ]);
  });
});
