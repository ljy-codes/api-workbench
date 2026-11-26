// Budgets also apply to compact output; no operation returns a partial document.
export const MAX_EXACT_JSON_INPUT_CHARS = 1_000_000;
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_DEPTH = 128;
const MAX_NODES = 50_000;
const MAX_NUMBER_CHARS = 4096;
const numberPattern = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** An exact decimal coefficient and exponent, never an expanded power of ten.
 * BigInt is used only for the bounded exponent, not to round the numeric value. */
export class ExactNumber {
  raw: string;
  canonical: string;

  constructor(raw: string) {
    if (raw.length > MAX_NUMBER_CHARS) throw new Error(`单个数字超过 ${MAX_NUMBER_CHARS} 字符上限。`);
    const match = numberPattern.exec(raw);
    if (!match) throw new Error('无效的 JSON 数字。');
    const fraction = match[3] ?? '';
    const digits = (match[2] + fraction).replace(/^0+/, '');
    const coefficient = digits.replace(/0+$/, '');
    const exponent = BigInt(match[4] ?? '0') + BigInt(digits.length - coefficient.length - fraction.length);
    this.raw = raw;
    this.canonical = coefficient ? `${match[1]}${coefficient}e${exponent}` : '0';
    Object.freeze(this);
  }
}

export function isExactNumber(value: unknown): value is ExactNumber {
  return value instanceof ExactNumber;
}

interface StringToken { value: string; raw: string }
interface SourceTokens {
  keys: Map<string, string>;
  strings: Map<string | number, StringToken>;
}
// Metadata is retained only as long as its parsed container is reachable.
const sourceTokens = new WeakMap<object, SourceTokens>();

function orderedObject(tokens: SourceTokens): Record<string, unknown> {
  const target = Object.create(null) as Record<string, unknown>;
  // Native objects reorder integer-looking keys. A null-prototype proxy exposes
  // insertion order to Object.keys, wildcard extraction and the existing diff.
  return new Proxy(target, {
    ownKeys(object) {
      return [
        ...[...tokens.keys.keys()].filter(key => Object.hasOwn(object, key)),
        ...Reflect.ownKeys(object).filter(key => typeof key !== 'string' || !tokens.keys.has(key)),
      ];
    },
  });
}

/** Strict JSON with the formatter's sole extension: trailing commas. */
export function parseExactJson(source: string): unknown {
  if (source.length > MAX_EXACT_JSON_INPUT_CHARS) throw new Error(`JSON 输入超过 ${MAX_EXACT_JSON_INPUT_CHARS} 字符上限。`);
  let position = 0;
  let nodes = 0;
  const fail = (): never => { throw new Error(`无效的 JSON，位置 ${position + 1}。`); };
  const whitespace = () => {
    while (position < source.length && /[ \t\r\n]/.test(source[position])) position++;
  };
  const readString = (): StringToken => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '"') {
        const raw = source.slice(start, position);
        try { return { raw, value: JSON.parse(raw) as string }; } catch { return fail(); }
      }
      if (char === '\\') position++;
      else if (char.charCodeAt(0) < 32) return fail();
    }
    return fail();
  };
  const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const readValue = (depth: number): unknown => {
    if (++nodes > MAX_NODES) throw new Error(`JSON 节点超过 ${MAX_NODES} 个上限。`);
    whitespace();
    const char = source[position];
    if (char === '"') return readString().value;
    if (char === '{' || char === '[') {
      if (depth >= MAX_DEPTH) throw new Error(`JSON 嵌套超过 ${MAX_DEPTH} 层上限。`);
      const array = char === '[';
      const closing = array ? ']' : '}';
      const tokens: SourceTokens = { keys: new Map(), strings: new Map() };
      const container = array ? [] as unknown[] : orderedObject(tokens);
      sourceTokens.set(container, tokens);
      position++;
      whitespace();
      if (source[position] === closing) { position++; return container; }
      while (position < source.length) {
        let key: string | number;
        if (Array.isArray(container)) key = container.length;
        else {
          if (source[position] !== '"') return fail();
          const token = readString();
          key = token.value;
          tokens.keys.set(key, token.raw);
          whitespace();
          if (source[position++] !== ':') return fail();
        }
        whitespace();
        const start = position;
        const stringValue = source[position] === '"';
        const value = readValue(depth + 1);
        if (Array.isArray(container)) container.push(value);
        else container[key] = value;
        if (stringValue) tokens.strings.set(key, { value: value as string, raw: source.slice(start, position) });
        else tokens.strings.delete(key);
        whitespace();
        if (source[position] === closing) { position++; return container; }
        if (source[position++] !== ',') return fail();
        whitespace();
        if (source[position] === closing) { position++; return container; }
      }
      return fail();
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, position)) { position += token.length; return value; }
    }
    numberToken.lastIndex = position;
    const match = numberToken.exec(source);
    if (!match) return fail();
    position = numberToken.lastIndex;
    return new ExactNumber(match[0]);
  };
  const value = readValue(0);
  whitespace();
  if (position !== source.length) return fail();
  return value;
}

/** Two-space formatting by default. Parsed keys, string tokens and numbers keep
 * their original spelling; ordinary JSON values are supported as well. */
export function stringifyExactJson(value: unknown, compact = false): string {
  const parts: string[] = [];
  const ancestors = new WeakSet<object>();
  let length = 0;
  let nodes = 0;
  const append = (text: string) => {
    length += text.length;
    if (length > MAX_OUTPUT_CHARS) throw new Error(`JSON 输出超过 ${MAX_OUTPUT_CHARS} 字符上限。`);
    parts.push(text);
  };
  const quote = (text: string) => {
    if (text.length > MAX_OUTPUT_CHARS) throw new Error(`JSON 输出超过 ${MAX_OUTPUT_CHARS} 字符上限。`);
    return JSON.stringify(text);
  };
  const newline = (depth: number) => { if (!compact) append('\n' + '  '.repeat(depth)); };
  const write = (item: unknown, depth: number, token?: StringToken): void => {
    if (++nodes > MAX_NODES) throw new Error(`JSON 输出节点超过 ${MAX_NODES} 个上限。`);
    if (isExactNumber(item)) { append(item.raw); return; }
    if (item === null) { append('null'); return; }
    if (typeof item === 'string') { append(token?.value === item ? token.raw : quote(item)); return; }
    if (typeof item === 'boolean') { append(String(item)); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { append(JSON.stringify(item)); return; }
    if (typeof item !== 'object') throw new Error('不支持的 JSON 值类型。');
    if (ancestors.has(item)) throw new Error('JSON 输出不能包含循环引用。');
    if (depth >= MAX_DEPTH) throw new Error(`JSON 输出嵌套超过 ${MAX_DEPTH} 层上限。`);
    ancestors.add(item);
    const array = Array.isArray(item);
    const tokens = sourceTokens.get(item);
    // Check wide native inputs before allocating a key list or iterating them.
    if (array && item.length > MAX_NODES - nodes) throw new Error(`JSON 输出节点超过 ${MAX_NODES} 个上限。`);
    const keys = array ? undefined : Object.keys(item);
    const size = array ? item.length : keys!.length;
    if (size > MAX_NODES - nodes) throw new Error(`JSON 输出节点超过 ${MAX_NODES} 个上限。`);
    append(array ? '[' : '{');
    for (let i = 0; i < size; i++) {
      if (i) append(',');
      newline(depth + 1);
      const key = array ? i : keys![i];
      if (!array) append((tokens?.keys.get(key as string) ?? quote(key as string)) + (compact ? ':' : ': '));
      const child = (item as Record<string | number, unknown>)[key];
      write(child, depth + 1, tokens?.strings.get(key));
    }
    if (size) newline(depth);
    append(array ? ']' : '}');
    ancestors.delete(item);
  };
  write(value, 0);
  return parts.join('');
}
