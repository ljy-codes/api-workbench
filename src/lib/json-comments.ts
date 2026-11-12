export interface JsonCommentRange {
  from: number;
  to: number;
  kind: 'line' | 'block';
}

/** Find comment ranges using CodeMirror's UTF-16 document coordinates. */
export function findJsonCommentRanges(source: string): JsonCommentRange[] {
  const ranges: JsonCommentRange[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index++;
      continue;
    }
    if (char === '"') {
      inString = true;
      index++;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const from = index;
      index += 2;
      while (index < source.length && source[index] !== '\r' && source[index] !== '\n') index++;
      ranges.push({ from, to: index, kind: 'line' });
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const from = index;
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) throw new Error('JSON 注释未闭合');
      ranges.push({ from, to: index, kind: 'block' });
      continue;
    }
    index++;
  }
  return ranges;
}

/** Replace JSON comments with whitespace while preserving line positions. */
export function stripJsonComments(source: string): string {
  const output = source.split('');
  for (const range of findJsonCommentRanges(source)) {
    for (let index = range.from; index < range.to; index++) {
      if (output[index] !== '\r' && output[index] !== '\n') output[index] = ' ';
    }
  }
  return output.join('');
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

/** Toggle // comments for the lines touched by a CodeMirror selection. */
export function toggleJsonLineComments(source: string, from: number, to: number): string {
  const starts = lineStarts(source);
  const start = Math.max(0, Math.min(from, source.length));
  const end = Math.max(start, Math.min(to, source.length));
  const firstLine = lineIndexAt(starts, start);
  const lastLine = lineIndexAt(starts, Math.max(start, end - (end > start ? 1 : 0)));
  const lines = [];
  for (let index = firstLine; index <= lastLine; index++) {
    const lineStart = starts[index];
    const lineEnd = starts[index + 1] ?? source.length;
    const contentEnd = source[lineEnd - 2] === '\r' && source[lineEnd - 1] === '\n'
      ? lineEnd - 2
      : source[lineEnd - 1] === '\n' || source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    lines.push({ index, lineStart, contentEnd, text: source.slice(lineStart, contentEnd) });
  }
  const nonEmpty = lines.filter(line => line.text.trim().length > 0);
  if (!nonEmpty.length) return source;
  const uncomment = nonEmpty.every(line => /^\s*\/\/(?: ?|$)/.test(line.text));
  let result = source;
  for (const line of [...lines].reverse()) {
    const prefix = line.text.match(/^\s*/)?.[0] ?? '';
    const rest = line.text.slice(prefix.length);
    const next = !line.text.trim()
      ? line.text
      : uncomment
        ? (/^\/\/ ?/.test(rest) ? prefix + rest.slice(rest.startsWith('// ') ? 3 : 2) : line.text)
        : (/^\/\//.test(rest) ? line.text : `${prefix}// ${rest}`);
    result = result.slice(0, line.lineStart) + next + result.slice(line.contentEnd);
  }
  return result;
}
