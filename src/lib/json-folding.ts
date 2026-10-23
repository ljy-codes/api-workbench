export interface JsonFold {
  from: number;
  to: number;
  depth: number;
  kind: '{' | '[';
  count: number;
}

// Input is already validated and pretty-printed JSON. Scan once without recursion
// so folding large responses doesn't wait for CodeMirror's viewport-limited parser.
export function jsonFolds(value: string): Map<number, JsonFold> {
  const folds = new Map<number, JsonFold>();
  const stack: (JsonFold & { lineFrom: number; hasValue: boolean })[] = [];
  let lineFrom = 0, inString = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\n') lineFrom = i + 1;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    const parent = stack[stack.length - 1];
    if (char === '{' || char === '[') {
      if (parent) parent.hasValue = true;
      stack.push({ from: i + 1, to: 0, lineFrom, depth: stack.length, kind: char, count: 0, hasValue: false });
    } else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || (char === '}' ? frame.kind !== '{' : frame.kind !== '[')) return new Map();
      if (frame.lineFrom !== lineFrom) {
        folds.set(frame.lineFrom, {
          from: frame.from, to: i, depth: frame.depth, kind: frame.kind,
          count: frame.hasValue ? frame.count + 1 : 0,
        });
      }
    } else if (char === ',') {
      if (parent) parent.count++;
    } else if (char === '"') {
      if (parent) parent.hasValue = true;
      inString = true;
    } else if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') {
      if (parent) parent.hasValue = true;
    }
  }
  return stack.length || inString ? new Map() : folds;
}
