import { checkDevText } from './dev-tools';

/** A flat text list, not a SQL parser. Never coerce values to JS numbers:
 * identifiers must retain leading zeroes, precision, order and duplicates. */
export function toSqlStringList(source: string): string {
  let input = checkDevText(source).trim();
  if (input.startsWith('[')) {
    if (!input.endsWith(']')) throw new Error('列表格式不完整，请补齐数组的右方括号。');
    input = input.slice(1, -1);
  }
  const separator = (char: string) => char === ',' || char === '，' || char === '\n' || char === '\r';
  const items: string[] = [];
  let position = 0;
  while (position < input.length) {
    while (position < input.length && (separator(input[position]) || /\s/.test(input[position]))) position++;
    if (position === input.length) break;
    let value: string;
    const quote = input[position];
    if (quote === '"' || quote === "'") {
      const start = position++;
      let closed = false;
      let singleQuoted = '';
      while (position < input.length) {
        const char = input[position++];
        if (quote === '"' && char === '\\') {
          // JSON escapes are decoded only after locating the complete string.
          position++;
        } else if (char === quote) {
          if (quote === "'" && input[position] === "'") { singleQuoted += "'"; position++; }
          else { closed = true; break; }
        } else if (quote === "'") singleQuoted += char;
      }
      if (!closed) throw new Error('列表中有未闭合的引号，请检查输入。');
      if (quote === '"') {
        try { value = JSON.parse(input.slice(start, position)) as string; }
        catch { throw new Error('双引号字符串的格式或转义无效，请使用 JSON 字符串格式。'); }
      } else value = singleQuoted;
      while (position < input.length && !separator(input[position]) && /\s/.test(input[position])) position++;
      if (position < input.length && !separator(input[position])) {
        throw new Error('引号后格式无效，请用逗号或换行分隔列表项。');
      }
    } else {
      const start = position;
      while (position < input.length && !separator(input[position])) position++;
      value = input.slice(start, position).trim();
      if (/[\[\]{}]/.test(value)) throw new Error('仅支持一维字符串列表，不支持嵌套数组或对象。');
    }
    // SQL-standard string literals escape an apostrophe by doubling it.
    items.push(`'${value.replace(/'/g, "''")}'`);
  }
  if (!items.length) throw new Error('列表为空，请输入至少一个值。');
  return checkDevText(items.join(','), '输出');
}
