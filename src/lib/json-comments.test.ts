import { describe, expect, it } from 'vitest';
import { findJsonCommentRanges, stripJsonComments, toggleJsonLineComments } from './json-comments';

describe('JSON 注释转换', () => {
  it('移除字段注释但保留字符串内容和换行位置', () => {
    const source = `{
  // "disabled": "{{secret}}",
  "url": "https://example.test/a//b",
  "text": "/* keep this */"
}`;
    const stripped = stripJsonComments(source);

    expect(JSON.parse(stripped)).toEqual({
      url: 'https://example.test/a//b',
      text: '/* keep this */',
    });
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    expect(stripped).not.toContain('{{secret}}');
  });

  it('支持块注释并拒绝未闭合注释', () => {
    expect(JSON.parse(stripJsonComments('{"enabled": true, /* disabled */ "value": 1}')))
      .toEqual({ enabled: true, value: 1 });
    expect(() => stripJsonComments('{"enabled": true /* disabled')).toThrow('JSON 注释未闭合');
  });

  it('普通斜杠内容不被当作注释', () => {
    const source = '{"path": "/api/v1/items", "ratio": 10/2}';
    expect(stripJsonComments(source)).toBe(source);
  });

  it('返回 UTF-16 编辑器坐标并支持快捷键注释/取消注释选中行', () => {
    const source = `{
  "name": "中文",
  "enabled": true
}`;
    const commented = toggleJsonLineComments(source, source.indexOf('"name"'), source.indexOf('"enabled"'));
    expect(commented).toBe(`{
  // "name": "中文",
  // "enabled": true
}`);
    const selectionEnd = commented.indexOf('\n}', commented.indexOf('//'));
    expect(toggleJsonLineComments(commented, commented.indexOf('//'), selectionEnd))
      .toBe(source);
    const commentStart = commented.indexOf('//');
    expect(findJsonCommentRanges(commented)).toEqual([
      { from: commentStart, to: commentStart + '// "name": "中文",'.length, kind: 'line' },
      { from: commented.indexOf('//', commentStart + 1), to: commented.indexOf('//', commentStart + 1) + '// "enabled": true'.length, kind: 'line' },
    ]);
  });
});
