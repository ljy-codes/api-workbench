export type TimestampUnit = 'seconds' | 'milliseconds';
export interface DateResult { seconds: string; milliseconds: string; utc: string; local: string }

const MAX_BYTES = 1024 * 1024;

/** Bound UTF-8 bytes without allocating an unbounded encoded copy or replacing
 * lone surrogates. Rejected drafts remain in the caller's editor unchanged. */
export function checkDevText(text: string, kind: '输入' | '输出' = '输入'): string {
  const overBudget = () => { throw new Error(`${kind}超过 1 MiB（UTF-8）上限。`); };
  if (text.length > MAX_BYTES) overBudget();
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new Error('存在未配对的 Unicode 字符，无法转换为 UTF-8。');
      bytes += 4;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new Error('存在未配对的 Unicode 字符，无法转换为 UTF-8。');
    } else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > MAX_BYTES) overBudget();
  }
  return text;
}

export function encodeUrl(source: string): string {
  return checkDevText(encodeURIComponent(checkDevText(source)), '输出');
}

export function decodeUrl(source: string): string {
  checkDevText(source);
  let text: string;
  try { text = decodeURIComponent(source); }
  catch { throw new Error('URL 编码无效，请检查百分号转义和 UTF-8 字节。'); }
  return checkDevText(text, '输出');
}

export function encodeBase64(source: string): string {
  checkDevText(source);
  const bytes = new TextEncoder().encode(source);
  // Check expansion before assembling the binary string.
  if (Math.ceil(bytes.length / 3) * 4 > MAX_BYTES) throw new Error('输出超过 1 MiB（UTF-8）上限。');
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(parts.join(''));
}

export function decodeBase64(source: string): string {
  checkDevText(source);
  // Standard RFC 4648 alphabet, full padding and canonical unused bits.
  if (source.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) {
    throw new Error('Base64 格式无效，需使用标准字母表及完整的 = 填充，不含空白。');
  }
  let binary: string;
  try { binary = atob(source); }
  catch { throw new Error('Base64 格式无效。'); }
  if (btoa(binary) !== source) throw new Error('Base64 填充位无效，请输入规范的 Base64。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch { throw new Error('Base64 解码内容不是有效 UTF-8 文本。'); }
  return checkDevText(text, '输出');
}

function describeDate(milliseconds: number): DateResult {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new Error('时间戳超出有效日期范围。');
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const year = date.getFullYear();
  const localYear = year < 0 ? `-${pad(-year, 6)}` : pad(year, 4);
  const local = `${localYear}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} (${zone})`;
  return { seconds: String(milliseconds / 1000), milliseconds: String(milliseconds), utc: date.toISOString(), local };
}

export function timestampToDate(source: string, unit: TimestampUnit): DateResult {
  const text = checkDevText(source).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new Error('请输入十进制整数时间戳，并选择秒或毫秒。');
  if (unit !== 'seconds' && unit !== 'milliseconds') throw new Error('时间戳单位无效，请选择秒或毫秒。');
  const number = Number(text);
  const milliseconds = unit === 'seconds' ? number * 1000 : number;
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(milliseconds)) throw new Error('时间戳超出安全整数范围。');
  return describeDate(milliseconds);
}

/** Require a timezone and reject Date.parse's silent calendar rollover.
 * ISO input uses four-digit years and at most millisecond precision. */
export function isoToDate(source: string): DateResult {
  const text = checkDevText(source).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) throw new Error('请输入带 Z 或 ±HH:mm 时区的 ISO 日期时间，最多保留三位毫秒。');
  const [, y, m, d, h, min, s, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error('ISO 日期或时间无效，请检查日历日期、时分秒和时区。');
  }
  return describeDate(Date.parse(text));
}

function checkBase64Url(segment: string, allowEmpty = false): void {
  if ((!segment && !allowEmpty) || !/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) {
    throw new Error('JWT 分段不是有效的无填充 Base64URL。');
  }
  // Validate unused bits without decoding the opaque signature segment.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(segment.at(-1) ?? 'A');
  if ((segment.length % 4 === 2 && last % 16) || (segment.length % 4 === 3 && last % 4)) {
    throw new Error('JWT Base64URL 填充位无效。');
  }
}

function jwtObject(segment: string, label: string): string {
  checkBase64Url(segment);
  const standard = segment.replace(/-/g, '+').replace(/_/g, '/');
  const raw = decodeBase64(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`JWT ${label} 不是有效 JSON 对象。`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`JWT ${label} 必须为 JSON 对象。`);
  }
  // Keep the original number spelling and whitespace; JSON.stringify would
  // silently round large IDs. Parsed claims are neither evaluated nor used.
  return raw;
}

/** Structure inspection only. Never verifies a signature, trusts claims,
 * evaluates exp/nbf or returns any authentication/authorization decision. */
export function decodeJwt(source: string): { header: string; payload: string } {
  const parts = checkDevText(source).trim().split('.');
  if (parts.length !== 3) throw new Error('JWT 必须包含 Header.Payload.Signature 三段；不支持加密的 JWE。');
  checkBase64Url(parts[2], true);
  const header = jwtObject(parts[0], 'Header');
  const payload = jwtObject(parts[1], 'Payload');
  checkDevText(header + payload, '输出');
  return { header, payload };
}
