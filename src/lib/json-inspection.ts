export type JsonPath = (string | number)[];
export interface JsonRange { from: number; to: number }
export interface JsonNode extends JsonRange { path: JsonPath }
export type JsonLookup = { found: true; value: unknown } | { found: false };

const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
export function formatJsonPath(path: JsonPath): string {
  return '$' + path.map(key => typeof key === 'number' ? `[${key}]`
    : identifier.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('');
}

/** A deliberately small path grammar; never evaluate expressions or follow prototypes. */
export function parseJsonPath(input: string): JsonPath | null {
  const text = input.trim();
  if (!text) return null;
  const path: JsonPath = [];
  let i = text.startsWith('$') ? 1 : 0;
  if (!i && text[0] !== '[') {
    const first = text.match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)?.[0];
    if (!first) return null;
    path.push(first); i = first.length;
  }
  while (i < text.length) {
    if (text[i] === '.') {
      const key = text.slice(i + 1).match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)?.[0];
      if (!key) return null;
      path.push(key); i += key.length + 1;
    } else if (text[i] === '[') {
      i++;
      if (text[i] === '"') {
        const end = stringEnd(text, i);
        if (end < 0 || text[end] !== ']') return null;
        try { path.push(JSON.parse(text.slice(i, end))); } catch { return null; }
        i = end + 1;
      } else {
        const index = text.slice(i).match(/^(0|[1-9]\d*)\]/)?.[1];
        if (index === undefined || !Number.isSafeInteger(Number(index))) return null;
        path.push(Number(index)); i += index.length + 1;
      }
    } else return null;
  }
  return path;
}

export function resolveJsonPath(root: unknown, path: JsonPath): JsonLookup {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object' ||
      (Array.isArray(value) && typeof key !== 'number') ||
      !Object.prototype.hasOwnProperty.call(value, key)) return { found: false };
    value = (value as Record<string | number, unknown>)[key];
  }
  return { found: true, value };
}

interface PathRef { parent: PathRef | null; key: string | number; depth: number }
function pathOf(ref: PathRef | null): JsonPath {
  const result: JsonPath = [];
  for (let item = ref; item; item = item.parent) result.push(item.key);
  return result.reverse();
}
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}
interface ScanNode extends JsonRange { ref: PathRef | null; keyFrom: number }

// Source has already been validated. The scanner uses linked paths and a stack,
// not an AST or recursive calls. It runs only when a field is inspected.
function scanJson(text: string, visit: (node: ScanNode) => boolean | void): void {
  const stack: (ScanNode & { array: boolean; index: number; key?: string; pendingKeyFrom?: number })[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/[\s,:]/.test(c)) { i++; continue; }
    if (c === '}' || c === ']') {
      const frame = stack.pop();
      if (!frame) return;
      if (visit({ ...frame, to: i + 1 })) return;
      i++; continue;
    }
    const parent = stack[stack.length - 1];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return;
      let next = end;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (parent && !parent.array && text[next] === ':') {
        parent.key = JSON.parse(text.slice(i, end)) as string;
        parent.pendingKeyFrom = i; i = next + 1; continue;
      }
    }
    const ref: PathRef | null = parent ? {
      parent: parent.ref, key: parent.array ? parent.index++ : parent.key!,
      depth: (parent.ref?.depth ?? 0) + 1,
    } : null;
    const node: ScanNode = { from: i, to: i, ref, keyFrom: parent?.pendingKeyFrom ?? i };
    if (parent) parent.pendingKeyFrom = undefined;
    if (c === '{' || c === '[') {
      stack.push({ ...node, array: c === '[', index: 0 }); i++; continue;
    }
    const end = c === '"' ? stringEnd(text, i) : (() => {
      let j = i;
      while (j < text.length && !/[\s,\]}]/.test(text[j])) j++;
      return j;
    })();
    if (end <= i) return;
    if (visit({ ...node, to: end })) return;
    i = end;
  }
}

export function jsonRange(text: string, path: JsonPath): JsonRange | null {
  let result: JsonRange | null = null;
  scanJson(text, node => {
    if ((node.ref?.depth ?? 0) !== path.length) return;
    let ref = node.ref;
    for (let i = path.length - 1; i >= 0; i--, ref = ref!.parent) {
      if (ref!.key !== path[i]) return;
    }
    result = { from: node.from, to: node.to }; return true;
  });
  return result;
}

export function jsonNodeAt(text: string, position: number): JsonNode | null {
  let result: JsonNode | null = null;
  scanJson(text, node => {
    if (node.keyFrom <= position && position < node.to) {
      result = { from: node.from, to: node.to, path: pathOf(node.ref) };
      return true; // Postorder traversal reaches the smallest enclosing node first.
    }
  });
  return result;
}

export function arrayPaths(root: unknown, maxArrays = 100, maxNodes = 20_000): { paths: JsonPath[]; truncated: boolean } {
  const paths: JsonPath[] = [];
  const stack: { value: unknown; ref: PathRef | null }[] = [{ value: root, ref: null }];
  let count = 0, truncated = false;
  while (stack.length) {
    if (++count > maxNodes) { truncated = true; break; }
    const { value, ref } = stack.pop()!;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (paths.length >= maxArrays) { truncated = true; break; }
      paths.push(pathOf(ref));
    }
    const keys: (string | number)[] = Array.isArray(value)
      ? Array.from({ length: Math.min(value.length, maxNodes) }, (_, i) => i) : Object.keys(value);
    const budget = Math.max(0, maxNodes - count - stack.length);
    if (keys.length > budget) truncated = true;
    for (let i = Math.min(keys.length, budget) - 1; i >= 0; i--) {
      const key = keys[i];
      stack.push({ value: (value as Record<string | number, unknown>)[key], ref: { key, parent: ref, depth: (ref?.depth ?? 0) + 1 } });
    }
  }
  return { paths, truncated };
}

export function arrayColumns(rows: unknown[]): { keys: string[]; scalar: boolean; truncated: boolean } {
  if (!rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) {
    return { keys: ['值'], scalar: true, truncated: false };
  }
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row as object)) {
      keys.add(key);
      if (keys.size > 100) return { keys: [...keys].slice(0, 100), scalar: false, truncated: true };
    }
  }
  return { keys: [...keys], scalar: false, truncated: false };
}

export function cellValue(row: unknown, key: string, scalar: boolean): JsonLookup {
  return scalar ? { found: true, value: row } : resolveJsonPath(row, [key]);
}

export function jsonPreview(value: unknown, limit = 160): string {
  if (value === undefined) return '（缺失）';
  if (value !== null && typeof value === 'object') {
    return Array.isArray(value) ? `[${value.length} 项]` : `{${Object.keys(value).length} 个字段}`;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}
