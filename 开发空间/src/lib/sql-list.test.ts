import { describe, expect, it } from 'vitest';
import { toSqlStringList } from './sql-list';

describe('SQL 字符串列表', () => {
  it.each([
    ['"1","23"', "'1','23'"],
    ['1,2,3', "'1','2','3'"],
    ['"9040470",\r\n"9055906",\r\n"9062281",', "'9040470','9055906','9062281'"],
    [' 001,\n900719925474099312345,001,null ', "'001','900719925474099312345','001','null'"],
    ['[ "01", 2, "中文🙂" ]', "'01','2','中文🙂'"],
    ['1，2，3', "'1','2','3'"],
    [',1,,\n2,\n', "'1','2'"],
    ['"",\'\',0', "'','','0'"],
    ['"a,b","  keep spaces  ","a\\nb"', "'a,b','  keep spaces  ','a\nb'"],
    ['"O\'Reilly",O\'Reilly,\'O\'\'Reilly\'', "'O''Reilly','O''Reilly','O''Reilly'"],
    ['"a\\"b",\'a"b\'', '\'a"b\',\'a"b\''],
    ['"C:\\\\files\\\\data"', "'C:\\files\\data'"],
    ['"x\'); DROP TABLE t; --"', "'x''); DROP TABLE t; --'"],
  ])('保留值与顺序：%j', (source, expected) => {
    expect(toSqlStringList(source)).toBe(expected);
    expect(toSqlStringList(expected)).toBe(expected);
  });

  it.each(['', ' \r\n ,， ', '[]'])('空列表 %j 不生成误导性结果', source => {
    expect(() => toSqlStringList(source)).toThrow(/至少|为空/);
  });

  it.each(['"1', "'2", '"1"x,2', '"bad\\q"', '[1,2', '1,2]', '[[1],2]', '{"id":1}'])(
    '格式不完整或嵌套输入 %j 明确报错，避免部分转换',
    source => { expect(() => toSqlStringList(source)).toThrow(/引号|格式|数组|列表|转义/); },
  );

  it('限制输入与引号展开后的输出，拒绝无效 Unicode', () => {
    expect(() => toSqlStringList('a'.repeat(1_048_577))).toThrow(/输入超过 1 MiB/);
    expect(() => toSqlStringList('a,'.repeat(300_000))).toThrow(/输出超过 1 MiB/);
    expect(() => toSqlStringList('\uD800')).toThrow(/Unicode/);
    expect(() => toSqlStringList('"\\ud800"')).toThrow(/Unicode/);
  });
});
