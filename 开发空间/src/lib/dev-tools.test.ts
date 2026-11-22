import { describe, expect, it } from 'vitest';
import {
  decodeBase64, decodeJwt, decodeUrl, encodeBase64, encodeUrl,
  isoToDate, timestampToDate,
} from './dev-tools';

describe('URL 组件编解码', () => {
  it('编码中文、保留空格与加号的区别，每次只解码一层', () => {
    expect(encodeUrl('中文 a+b/?=&')).toBe('%E4%B8%AD%E6%96%87%20a%2Bb%2F%3F%3D%26');
    expect(decodeUrl('%E4%B8%AD%E6%96%87%20a%2Bb')).toBe('中文 a+b');
    expect(decodeUrl('a+b')).toBe('a+b');
    expect(decodeUrl('%2520')).toBe('%20');
    expect(encodeUrl('')).toBe('');
  });

  it.each(['%', '%GG', '%E4%B8', '%FF', '\uD800'])('拒绝损坏的编码：%j', source => {
    expect(() => decodeUrl(source)).toThrow(/URL|UTF-8|Unicode/);
  });
});

describe('UTF-8 Base64', () => {
  it('准确转换中文、emoji、换行、零字节和 BOM', () => {
    expect(encodeBase64('中文🙂\n')).toBe('5Lit5paH8J+Zggo=');
    expect(decodeBase64('5Lit5paH8J+Zggo=')).toBe('中文🙂\n');
    expect(encodeBase64('\u0000')).toBe('AA==');
    expect(decodeBase64('77u/QQ==')).toBe('\uFEFFA');
    expect(decodeBase64('')).toBe('');
  });

  it.each(['YQ', 'YQ=', 'YQ===', 'Y Q==', 'YQ==\n', 'YR==', 'AA=A', '!!!!', '/w==', 'wK8='])(
    '拒绝非法标准 Base64、非规范填充及无效 UTF-8：%j', source => {
      expect(() => decodeBase64(source)).toThrow(/Base64|UTF-8/);
    },
  );

  it('拒绝未配对代理字符，避免静默替换原文', () => {
    expect(() => encodeBase64('\uD800')).toThrow(/Unicode|UTF-8/);
  });

  it('正常解码接近上限的大文本，不因校验正则递归耗尽栈', () => {
    expect(decodeBase64('YWFh'.repeat(262_144))).toBe('a'.repeat(786_432));
  });
});

describe('Unix 时间转换', () => {
  it('显式区分秒与毫秒，保留负数、零及毫秒精度', () => {
    expect(timestampToDate('0', 'seconds')).toMatchObject({
      seconds: '0', milliseconds: '0', utc: '1970-01-01T00:00:00.000Z',
    });
    expect(timestampToDate('1704067200', 'seconds').utc).toBe('2024-01-01T00:00:00.000Z');
    expect(timestampToDate('1704067200123', 'milliseconds')).toMatchObject({
      seconds: '1704067200.123', milliseconds: '1704067200123', utc: '2024-01-01T00:00:00.123Z',
    });
    expect(timestampToDate('-1', 'milliseconds').utc).toBe('1969-12-31T23:59:59.999Z');
    expect(timestampToDate(' 0 ', 'milliseconds').local).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it('解析带 Z 或明确偏移的 ISO 时间，独立于机器本地时区', () => {
    expect(isoToDate('2024-01-01T08:00:00.123+08:00')).toMatchObject({
      seconds: '1704067200.123', milliseconds: '1704067200123', utc: '2024-01-01T00:00:00.123Z',
    });
    expect(isoToDate('2024-02-29T00:00:00Z').utc).toBe('2024-02-29T00:00:00.000Z');
    expect(isoToDate('0099-01-01T00:00:00Z').utc).toBe('0099-01-01T00:00:00.000Z');
  });

  it('日期范围边缘的秒文本不因浮点除法舍入毫秒', () => {
    expect(timestampToDate('8639999999999999', 'milliseconds')).toMatchObject({
      seconds: '8639999999999.999', utc: '+275760-09-12T23:59:59.999Z',
    });
    expect(timestampToDate('-8639999999999999', 'milliseconds').seconds).toBe('-8639999999999.999');
    expect(timestampToDate('8639999999999003', 'milliseconds').seconds).toBe('8639999999999.003');
  });

  it.each(['', '1.1', '1e3', '0x10', 'NaN', 'Infinity', '9007199254740992', '8640000000000001'])(
    '拒绝非法、非整数或超出日期范围的时间戳：%j', source => {
      expect(() => timestampToDate(source, 'milliseconds')).toThrow(/时间戳|范围|整数/);
    },
  );

  it.each([
    '', '2024-01-01', '2024-01-01T00:00:00', '2023-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z', '2024-04-31T00:00:00Z', '2024-13-01T00:00:00Z',
    '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z',
    '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+08:60',
    '2024-01-01T00:00:00.1234Z', 'not a date',
  ])('拒绝无时区、自动日期进位或格式错误：%j', source => {
    expect(() => isoToDate(source)).toThrow(/ISO|日期|时区|时间/);
  });
});

describe('JWT 结构查看', () => {
  const header = 'eyJhbGciOiJIUzI1NiJ9'; // {"alg":"HS256"}
  const payload = 'eyJzdWIiOiIxMjMifQ'; // {"sub":"123"}

  it('只返回 Header/Payload 原文，不创建认证结果且不舍入大整数', () => {
    expect(decodeJwt(`${header}.${payload}.c2ln`)).toEqual({
      header: '{"alg":"HS256"}', payload: '{"sub":"123"}',
    });
    const exactPayload = btoa('{"id":9223372036854775807}').replace(/=/g, '');
    expect(decodeJwt(`${header}.${exactPayload}.`).payload).toBe('{"id":9223372036854775807}');
  });

  it.each([
    '', 'a.b', 'a.b.c.d', 'a.b.c', 'e30.e30.***', 'e30.e30.a',
    'e30=.e30.c2ln', 'W10.e30.c2ln', 'e30.bnVsbA.c2ln',
    'e30.eyJ4IjoxLH0.c2ln', 'e30._w.c2ln',
  ])('拒绝无效分段、Base64URL、UTF-8 或非 JSON 对象：%j', source => {
    expect(() => decodeJwt(source)).toThrow(/JWT|Header|Payload|UTF-8|Base64/);
  });
});

describe('输入输出预算', () => {
  it('URL 与 Base64 按 UTF-8 字节限制输入、限制编码膨胀输出', () => {
    expect(() => encodeUrl('a'.repeat(1_048_577))).toThrow(/输入.*1 MiB/);
    expect(() => encodeBase64('中'.repeat(350_000))).toThrow(/输入.*1 MiB/);
    expect(() => encodeUrl(' '.repeat(350_000))).toThrow(/输出.*1 MiB/);
    expect(() => encodeBase64('a'.repeat(800_000))).toThrow(/输出.*1 MiB/);
    expect(encodeBase64('a'.repeat(786_432))).toHaveLength(1_048_576);
  });

  it('所有入口都限制原始文本，不能通过 trim 绕过预算', () => {
    const tooLarge = ' '.repeat(1_048_577);
    for (const convert of [decodeUrl, decodeBase64, decodeJwt, isoToDate]) {
      expect(() => convert(tooLarge)).toThrow(/输入.*1 MiB/);
    }
    expect(() => timestampToDate(tooLarge, 'seconds')).toThrow(/输入.*1 MiB/);
  });
});
