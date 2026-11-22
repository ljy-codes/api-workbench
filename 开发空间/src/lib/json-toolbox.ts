import { isExactNumber, parseExactJson, stringifyExactJson } from './json-exact';

export type ExtractionFormat = 'json' | 'lines' | 'csv' | 'sql';

const MAX_INPUT_CHARS = 1_000_000;
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_PATH_CHARS = 4096;
const MAX_PATH_STEPS = 128;
const MAX_RESULTS = 10_000;
const MAX_VISITS = 50_000;
const wildcard = Symbol('wildcard');
type PathStep = string | number | typeof wildcard;

function checkInput(source: string): void {
  if (source.length > MAX_INPUT_CHARS) throw new Error(`输入超过 ${MAX_INPUT_CHARS} 字符上限。`);
}

function checkOutput(text: string): string {
  if (text.length > MAX_OUTPUT_CHARS) throw new Error(`输出超过 ${MAX_OUTPUT_CHARS} 字符上限。`);
  return text;
}

/** Arbitrary text becomes one JSON string, including JSON-looking input. */
export function escapeJsonText(source: string): string {
  checkInput(source);
  return checkOutput(JSON.stringify(source));
}

/** Only a valid JSON string is accepted; its contents are never parsed again. */
export function unescapeJsonText(source: string): string {
  checkInput(source);
  const text = source.trim();
  if (!text.startsWith('"')) throw new Error('请输入带双引号的有效 JSON 字符串。');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('请输入带双引号的有效 JSON 字符串。'); }
  if (typeof value !== 'string') throw new Error('只能还原 JSON 字符串。');
  return checkOutput(value);
}

// A small grammar, not an expression language. No eval, filters or recursion.
function extractionPath(input: string): PathStep[] {
  if (input.length > MAX_PATH_CHARS) throw new Error(`字段路径超过 ${MAX_PATH_CHARS} 字符上限。`);
  const text = input.trim();
  const steps: PathStep[] = [];
  let position = text.startsWith('$') ? 1 : 0;
  const fail = (): never => { throw new Error(`字段路径无效或包含不支持的语法，位置 ${position + 1}。`); };
  if (!text || (!position && text[0] !== '.' && text[0] !== '[')) return fail();
  const identifier = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
  const indexToken = /(?:0|[1-9]\d*)/y;
  while (position < text.length) {
    if (steps.length >= MAX_PATH_STEPS) throw new Error(`字段路径超过 ${MAX_PATH_STEPS} 段上限。`);
    if (text[position] === '.') {
      identifier.lastIndex = ++position;
      const match = identifier.exec(text);
      if (!match) return fail();
      steps.push(match[0]);
      position = identifier.lastIndex;
      continue;
    }
    if (text[position++] !== '[') return fail();
    const char = text[position];
    if (char === '*') { steps.push(wildcard); position++; }
    else if (char === '"' || char === "'") {
      const quote = char;
      const normalized: string[] = ['"'];
      position++;
      let closed = false;
      while (position < text.length) {
        const current = text[position++];
        if (current === quote) { closed = true; break; }
        if (current === '\\') {
          const escaped = text[position++];
          if (escaped === undefined) return fail();
          // Single-quoted keys use JSON escapes plus \'. Double-quoted keys
          // remain strict JSON strings, so \' there is deliberately invalid.
          if (quote === "'" && escaped === "'") normalized.push("'");
          else normalized.push('\\', escaped);
        } else normalized.push(current === '"' ? '\\"' : current);
      }
      if (!closed) return fail();
      normalized.push('"');
      try { steps.push(JSON.parse(normalized.join('')) as string); } catch { return fail(); }
    } else {
      indexToken.lastIndex = position;
      const match = indexToken.exec(text);
      if (!match) return fail();
      const index = Number(match[0]);
      if (!Number.isSafeInteger(index)) return fail();
      steps.push(index);
      position = indexToken.lastIndex;
    }
    if (text[position++] !== ']') return fail();
  }
  return steps;
}

function isContainer(value: unknown): value is Record<string | number, unknown> {
  return value !== null && typeof value === 'object' && !isExactNumber(value);
}

/** Type tags and structural delimiters prevent string/number collisions.
 * Objects ignore key order for equality, while output keeps the first match. */
function deduplicationKey(value: unknown): string {
  if (isExactNumber(value)) return `number:${value.canonical}`;
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (Array.isArray(value)) return `array:[${value.map(deduplicationKey).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `object:{${Object.keys(object).sort().map(key =>
    `${JSON.stringify(key)}:${deduplicationKey(object[key])}`).join(',')}}`;
}

function literalText(value: unknown): string {
  return typeof value === 'string' ? value : stringifyExactJson(value, true);
}

function sqlLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (isExactNumber(value)) return value.raw;
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw new Error('SQL 输出仅支持字符串、数字、null 和布尔值，不能包含对象或数组。');
}

export function extractJsonValues(
  source: string,
  path: string,
  options: { format?: ExtractionFormat; deduplicate?: boolean } = {},
): { text: string; count: number } {
  const format = options.format ?? 'json';
  if (!['json', 'lines', 'csv', 'sql'].includes(format)) throw new Error('不支持的提取输出格式。');
  const steps = extractionPath(path);
  let values = [parseExactJson(source)];
  let visits = 0;
  for (const step of steps) {
    const next: unknown[] = [];
    const add = (value: unknown) => {
      if (++visits > MAX_VISITS) throw new Error(`路径访问节点超过 ${MAX_VISITS} 个上限。`);
      next.push(value);
    };
    for (const value of values) {
      if (!isContainer(value)) continue;
      if (step === wildcard) {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) if (Object.hasOwn(value, i)) add(value[i]);
        } else {
          for (const key of Object.keys(value)) add(value[key]);
        }
      } else if ((Array.isArray(value) ? typeof step === 'number' : typeof step === 'string')
        && Object.hasOwn(value, step)) add(value[step]);
    }
    values = next;
  }
  if (values.length > MAX_RESULTS) throw new Error(`匹配结果超过 ${MAX_RESULTS} 项上限，请缩小字段路径范围。`);
  if (options.deduplicate) {
    const seen = new Set<string>();
    values = values.filter(value => {
      const key = deduplicationKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const count = values.length;
  if (format === 'json') return { text: stringifyExactJson(values), count };
  if (!count) return { text: '', count: 0 };
  const parts: string[] = [];
  let length = 0;
  const append = (text: string) => {
    length += text.length;
    if (length > MAX_OUTPUT_CHARS) throw new Error(`提取输出超过 ${MAX_OUTPUT_CHARS} 字符上限。`);
    parts.push(text);
  };
  if (format === 'sql') append('IN (');
  for (let i = 0; i < values.length; i++) {
    if (i) append(format === 'lines' ? '\n' : format === 'sql' ? ', ' : ',');
    let text = format === 'sql' ? sqlLiteral(values[i]) : literalText(values[i]);
    if (format === 'csv' && (!text || /[",\r\n]/.test(text))) text = `"${text.replace(/"/g, '""')}"`;
    append(text);
  }
  if (format === 'sql') append(')');
  return { text: parts.join(''), count };
}
