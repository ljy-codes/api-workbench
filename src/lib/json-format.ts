export interface JsonFormatOptions {
  removeNull?: boolean;
  compact?: boolean;
}

// Only tolerate a trailing comma after a value, outside strings. Holes ([,]),
// doubled commas, comments and other malformed input must still fail validation.
function stripTrailingCommas(source: string): string {
  const parts: string[] = [];
  let inString = false, escaped = false, previous = '', start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; previous = '"'; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === ',') {
      let next = i + 1;
      while (/[ \r\n\t]/.test(source[next] ?? '')) next++;
      if ((source[next] === '}' || source[next] === ']') && previous && !'[{,:'.includes(previous)) {
        parts.push(source.slice(start, i));
        start = i + 1;
      }
    }
    if (!/[ \r\n\t]/.test(char)) previous = char;
  }
  return parts.length ? parts.join('') + source.slice(start) : source;
}

/** Validate with JSON.parse, but format the original tokens so IDs, exact
 * decimals, escape sequences and key order are never rounded or rewritten. */
export function formatJson(source: string, { removeNull = false, compact = false }: JsonFormatOptions = {}): string {
  const normalized = stripTrailingCommas(source);
  JSON.parse(normalized);
  let tokens: string[] = normalized.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)!;
  if (removeNull) {
    const kept: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].startsWith('"') && tokens[i + 1] === ':' && tokens[i + 2] === 'null') {
        if (tokens[i + 3] === ',') i += 3;
        else { if (kept.at(-1) === ',') kept.pop(); i += 2; }
      } else kept.push(tokens[i]);
    }
    tokens = kept;
  }
  if (compact) return tokens.join('');
  const output: string[] = [];
  let depth = 0;
  const newline = () => output.push('\n', '  '.repeat(depth));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      output.push(token);
      if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') {
        if (++depth > 512) throw new Error('JSON 嵌套超过 512 层，请使用压缩一行查看。');
        newline();
      }
    } else if (token === '}' || token === ']') {
      if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') { depth--; newline(); }
      output.push(token);
    } else if (token === ',') { output.push(token); newline(); }
    else output.push(token === ':' ? ': ' : token);
  }
  return output.join('');
}
