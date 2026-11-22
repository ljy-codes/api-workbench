export type CommandId =
  | 'save'
  | 'restore-closed-tab'
  | 'open-temporary'
  | 'open-json-tools'
  | 'open-dev-tools'
  | 'open-history'
  | 'open-settings'
  | 'toggle-layout'
  | 'toggle-sidebar'
  | 'open-shortcuts';

export type CommandGroup = '工作台' | '标签' | '请求与响应' | '工具';
export type ShortcutKey = 'Mod' | 'Shift' | 'Ctrl' | 'Alt' | 'Enter' | 'Esc' | 'Slash' | 'W' | 'S' | 'T' | 'P' | 'F' | 'K';

export interface CommandDefinition {
  id: CommandId;
  label: string;
  keywords: string[];
  group: CommandGroup;
  shortcut?: ShortcutKey[];
  description?: string;
}

export const COMMANDS: readonly CommandDefinition[] = [
  { id: 'save', label: '保存全部修改', keywords: ['保存', 'save', '工作区'], group: '工作台', shortcut: ['Mod', 'S'] },
  { id: 'restore-closed-tab', label: '恢复最近关闭标签', keywords: ['恢复', '关闭', '标签', 'tab'], group: '标签', shortcut: ['Mod', 'Shift', 'T'] },
  { id: 'open-temporary', label: '打开临时请求', keywords: ['临时', '请求', 'temporary'], group: '工作台' },
  { id: 'open-json-tools', label: '打开 JSON 工具', keywords: ['json', '格式化', '搜索'], group: '工具' },
  { id: 'open-dev-tools', label: '打开临时开发工具箱', keywords: ['开发', '工具箱', 'url', 'base64', 'jwt'], group: '工具' },
  { id: 'open-history', label: '打开请求时间线', keywords: ['请求', '时间线', '历史', '响应'], group: '请求与响应' },
  { id: 'open-settings', label: '打开设置', keywords: ['设置', '偏好', '主题'], group: '工具' },
  { id: 'toggle-layout', label: '切换上下 / 左右分屏', keywords: ['布局', '分屏', '上下', '左右'], group: '工作台' },
  { id: 'toggle-sidebar', label: '收起 / 展开接口侧栏', keywords: ['侧栏', '收起', '展开'], group: '工作台' },
  { id: 'open-shortcuts', label: '打开快捷键总览', keywords: ['快捷键', '帮助', '键盘'], group: '工具' },
] as const;

export const COMMAND_PALETTE_SHORTCUT: ShortcutKey[] = ['Mod', 'Shift', 'P'];

export interface ShortcutEntry {
  group: CommandGroup | '导航';
  label: string;
  shortcut: ShortcutKey[];
}

export const SHORTCUT_ENTRIES: readonly ShortcutEntry[] = [
  ...COMMANDS.filter(command => command.shortcut).map(command => ({ group: command.group, label: command.label, shortcut: command.shortcut! })),
  { group: '工作台', label: '聚焦接口搜索', shortcut: ['Slash'] },
  { group: '工作台', label: '聚焦接口搜索', shortcut: ['Mod', 'K'] },
  { group: '工作台', label: '打开命令面板', shortcut: COMMAND_PALETTE_SHORTCUT },
  { group: '请求与响应', label: '发送当前请求', shortcut: ['Mod', 'Enter'] },
  { group: '请求与响应', label: '搜索响应正文', shortcut: ['Mod', 'F'] },
  { group: '标签', label: '关闭当前普通接口标签', shortcut: ['Mod', 'W'] },
  { group: '工具', label: '关闭当前搜索、菜单或弹层', shortcut: ['Esc'] },
] as const;

export function formatShortcut(shortcut: readonly ShortcutKey[], mac = false): string {
  const labels: Record<ShortcutKey, string> = {
    Mod: mac ? '⌘' : 'Ctrl',
    Shift: '⇧',
    Ctrl: 'Ctrl',
    Alt: mac ? '⌥' : 'Alt',
    Enter: '↵',
    Esc: 'Esc',
    Slash: '/',
    W: 'W',
    S: 'S',
    T: 'T',
    P: 'P',
    F: 'F',
    K: 'K',
  };
  return shortcut.map(key => labels[key]).join(' ');
}

export function commandGroups(commands: readonly CommandDefinition[] = COMMANDS): { label: CommandGroup; commands: CommandDefinition[] }[] {
  const groups = new Map<CommandGroup, CommandDefinition[]>();
  for (const command of commands) {
    const list = groups.get(command.group) ?? [];
    list.push(command);
    groups.set(command.group, list);
  }
  const order: CommandGroup[] = ['工作台', '标签', '请求与响应', '工具'];
  return order.filter(label => groups.has(label)).map(label => ({ label, commands: groups.get(label)! }));
}
