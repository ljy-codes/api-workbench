import { formatJsonPath, parseJsonPath } from './json-inspection';

export interface JsonChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface JsonDiffOptions {
  ignore?: string[];
  matchById?: boolean;
  maxChanges?: number;
  maxNodes?: number;
}

const DEFAULT_MAX_CHANGES = 1000;
const DEFAULT_MAX_NODES = 20_000;

type JsonObject = Record<string, unknown>;
type Id = string | number;
interface Visit {
  path: string;
  key?: string;
  before: unknown;
  after: unknown;
  beforeExists: boolean;
  afterExists: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function propertyPath(parent: string, key: string): string {
  return parent + formatJsonPath([key]).slice(1);
}

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function* objectChildren(before: JsonObject, after: JsonObject, path: string): Generator<Visit> {
  // Enumerate lazily instead of allocating one task per property. Never read inherited values.
  for (const key in before) {
    if (!Object.hasOwn(before, key)) continue;
    const afterExists = Object.hasOwn(after, key);
    yield { path: propertyPath(path, key), key, before: before[key],
      after: afterExists ? after[key] : undefined, beforeExists: true, afterExists };
  }
  for (const key in after) {
    if (!Object.hasOwn(after, key) || Object.hasOwn(before, key)) continue;
    yield { path: propertyPath(path, key), key, before: undefined,
      after: after[key], beforeExists: false, afterExists: true };
  }
}

function* arrayChildren(before: unknown[], after: unknown[], path: string): Generator<Visit> {
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    yield { path: `${path}[${index}]`, before: before[index], after: after[index],
      beforeExists: index < before.length, afterExists: index < after.length };
  }
}

function* idChildren(
  before: unknown[], after: unknown[], path: string,
  beforeIds: Map<Id, number>, afterIds: Map<Id, number>,
): Generator<Visit> {
  for (const [id, index] of beforeIds) {
    if (!afterIds.has(id)) {
      yield { path: `${path}[${index}]`, before: before[index], after: undefined,
        beforeExists: true, afterExists: false };
    }
  }
  for (const [id, index] of afterIds) {
    const oldIndex = beforeIds.get(id);
    yield { path: `${path}[${index}]`, before: oldIndex === undefined ? undefined : before[oldIndex],
      after: after[index], beforeExists: oldIndex !== undefined, afterExists: true };
  }
}

/**
 * Parsed JSON inputs are read without mutation. Arrays use indexes unless both arrays
 * contain only objects with unique own string/number ids. Matched/added paths then
 * use current indexes; removed paths use baseline indexes.
 *
 * The node budget includes id validation. An unfinished scan is always truncated,
 * even if it found no changes. Added/removed subtrees are reported as one change.
 */
export function compareJson(
  baseline: unknown,
  current: unknown,
  options: JsonDiffOptions = {},
): { changes: JsonChange[]; truncated: boolean } {
  const maxChanges = limit(options.maxChanges, DEFAULT_MAX_CHANGES);
  const maxNodes = limit(options.maxNodes, DEFAULT_MAX_NODES);
  const ignored = new Set((options.ignore ?? []).map(rule => {
    const path = rule.startsWith('$') ? parseJsonPath(rule) : null;
    return path ? formatJsonPath(path) : rule;
  }));
  const changes: JsonChange[] = [];
  let nodes = 0;
  let truncated = false;
  const consumeNode = () => {
    if (nodes >= maxNodes) { truncated = true; return false; }
    nodes++;
    return true;
  };
  const indexIds = (items: unknown[]): Map<Id, number> | undefined => {
    const ids = new Map<Id, number>();
    for (let index = 0; index < items.length; index++) {
      if (!consumeNode()) return undefined;
      const item = items[index];
      if (!isObject(item) || !Object.hasOwn(item, 'id')) return undefined;
      const id = item.id;
      if ((typeof id !== 'string' && typeof id !== 'number')
        || (typeof id === 'number' && !Number.isFinite(id)) || ids.has(id)) return undefined;
      ids.set(id, index);
    }
    return ids;
  };
  const stack: Iterator<Visit>[] = [[{
    path: '$', before: baseline, after: current, beforeExists: true, afterExists: true,
  }][Symbol.iterator]()];

  while (stack.length && !truncated) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if (!consumeNode()) break;
    const visit = next.value;
    if (ignored.has(visit.path) || (visit.key !== undefined && ignored.has(visit.key))) continue;
    const { before, after, path, beforeExists, afterExists } = visit;
    let change: JsonChange | undefined;
    if (!beforeExists) change = { path, kind: 'added', after };
    else if (!afterExists) change = { path, kind: 'removed', before };
    else if (Object.is(before, after)) continue;
    else if (Array.isArray(before) && Array.isArray(after)) {
      let beforeIds: Map<Id, number> | undefined;
      let afterIds: Map<Id, number> | undefined;
      if (options.matchById) {
        beforeIds = indexIds(before);
        if (beforeIds && !truncated) afterIds = indexIds(after);
      }
      if (!truncated) stack.push(beforeIds && afterIds
        ? idChildren(before, after, path, beforeIds, afterIds)
        : arrayChildren(before, after, path));
      continue;
    } else if (isObject(before) && isObject(after)) {
      stack.push(objectChildren(before, after, path));
      continue;
    } else change = { path, kind: 'changed', before, after };

    if (changes.length >= maxChanges) { truncated = true; break; }
    changes.push(change);
  }
  return { changes, truncated };
}
