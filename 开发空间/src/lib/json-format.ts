import { findJsonCommentRanges, stripJsonComments, type JsonCommentRange } from './json-comments';

export interface JsonFormatOptions {
  removeNull?: boolean;
  compact?: boolean;
  maxOutputChars?: number;
}

interface JsonToken {
  type: 'json' | 'comment';
  text: string;
  kind?: JsonCommentRange['kind'];
}

function nextSignificant(source: string, start: number, comments: JsonCommentRange[], byFrom: Map<number, JsonCommentRange>): number {
  let index = start;
  while (index < source.length) {
    while (/[ \r\n\t]/.test(source[index] ?? '')) index++;
    const comment = byFrom.get(index);
    if (!comment) return index;
    index = comment.to;
  }
  return index;
}

// Only tolerate a trailing comma after a value, outside strings and comments.
// Holes ([,]), doubled commas and other malformed input still fail validation.
function stripTrailingCommas(source: string): string {
  const comments = findJsonCommentRanges(source);
  const byFrom = new Map(comments.map(comment => [comment.from, comment]));
  const output: string[] = [];
  let inString = false;
  let escaped = false;
  let previous = '';
  for (let i = 0; i < source.length;) {
    const comment = byFrom.get(i);
    if (comment) {
      output.push(source.slice(comment.from, comment.to));
      i = comment.to;
      continue;
    }
    const char = source[i];
    if (inString) {
      output.push(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; previous = '"'; }
      i++;
      continue;
    }
    if (char === '"') {
      inString = true;
      output.push(char);
      i++;
      continue;
    }
    if (char === ',') {
      const next = nextSignificant(source, i + 1, comments, byFrom);
      if ((source[next] === '}' || source[next] === ']') && previous && !'[{,:'.includes(previous)) {
        i++;
        continue;
      }
    }
    output.push(char);
    if (!/[ \r\n\t]/.test(char)) previous = char;
    i++;
  }
  return output.join('');
}

function tokenize(source: string): JsonToken[] {
  const comments = findJsonCommentRanges(source);
  const byFrom = new Map(comments.map(comment => [comment.from, comment]));
  const tokens: JsonToken[] = [];
  for (let i = 0; i < source.length;) {
    if (/[ \r\n\t]/.test(source[i])) {
      i++;
      continue;
    }
    const comment = byFrom.get(i);
    if (comment) {
      tokens.push({ type: 'comment', kind: comment.kind, text: source.slice(comment.from, comment.to) });
      i = comment.to;
      continue;
    }
    const start = i;
    if (source[i] === '"') {
      i++;
      let escaped = false;
      while (i < source.length) {
        const char = source[i++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') break;
      }
    } else if ('{}[],:' .includes(source[i])) {
      i++;
    } else {
      while (i < source.length && !/[ \r\n\t{}\[\],:"]/.test(source[i]) && !byFrom.has(i)) i++;
    }
    tokens.push({ type: 'json', text: source.slice(start, i) });
  }
  return tokens;
}

function previousJson(tokens: JsonToken[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (tokens[i].type === 'json') return i;
  return -1;
}

function nextJson(tokens: JsonToken[], index: number): number {
  for (let i = index + 1; i < tokens.length; i++) if (tokens[i].type === 'json') return i;
  return -1;
}

function removeNullFields(tokens: JsonToken[]): JsonToken[] {
  const removed = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'json' || !tokens[i].text.startsWith('"')) continue;
    const colon = nextJson(tokens, i);
    const value = colon >= 0 && tokens[colon].text === ':' ? nextJson(tokens, colon) : -1;
    if (value < 0 || tokens[value].text !== 'null') continue;
    removed.add(i);
    removed.add(colon);
    removed.add(value);
    const next = nextJson(tokens, value);
    if (next >= 0 && tokens[next].text === ',') removed.add(next);
    else {
      const previous = previousJson(tokens, i);
      if (previous >= 0 && tokens[previous].text === ',') removed.add(previous);
    }
  }
  return tokens.filter((_token, index) => !removed.has(index));
}

/** Validate with JSON.parse, but format the original tokens so IDs, exact
 * decimals, escape sequences and key order are never rounded or rewritten. */
export function formatJson(source: string, { removeNull = false, compact = false, maxOutputChars = Infinity }: JsonFormatOptions = {}): string {
  const normalized = stripTrailingCommas(source);
  JSON.parse(stripJsonComments(normalized));
  let tokens = tokenize(normalized);
  if (removeNull) tokens = removeNullFields(tokens);
  const output: string[] = [];
  let length = 0;
  const append = (text: string) => {
    length += text.length;
    if (length > maxOutputChars) throw new Error(`JSON 输出超过 ${maxOutputChars} 字符上限，请保留原文或缩小内容。`);
    output.push(text);
  };
  if (compact) {
    for (const token of tokens) append(token.text);
    return output.join('');
  }
  let depth = 0;
  let atLineStart = true;
  const indent = () => {
    if (atLineStart) {
      append('  '.repeat(depth));
      atLineStart = false;
    }
  };
  const newline = () => {
    if (!atLineStart) append('\n');
    atLineStart = true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (tokens[i].type === 'comment') {
      indent();
      const lastOutput = output.at(-1) ?? '';
      if (!atLineStart && lastOutput && !/\s/.test(lastOutput.at(-1) ?? '')) append(' ');
      append(tokens[i].text);
      if (tokens[i].kind === 'line') newline();
      else if (tokens[i].text.includes('\n')) atLineStart = tokens[i].text.endsWith('\n');
      else append(' ');
    } else if (token === '{' || token === '[') {
      indent();
      append(token);
      const next = tokens[i + 1];
      if (next && !(next.type === 'json' && (next.text === '}' || next.text === ']'))) {
        if (++depth > 512) throw new Error('JSON 嵌套超过 512 层，请使用压缩一行查看。');
        newline();
      }
    } else if (token === '}' || token === ']') {
      const previous = tokens[i - 1];
      if (!previous || previous.type === 'comment' || !['{', '['].includes(previous.text)) {
        depth--;
        if (!atLineStart) newline();
      }
      indent();
      append(token);
    } else if (token === ',') {
      indent();
      append(token);
      newline();
    } else {
      indent();
      append(token === ':' ? ': ' : token);
      atLineStart = false;
    }
  }
  return output.join('');
}
