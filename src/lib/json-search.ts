import type { JsonRange } from './json-inspection';

export function findJsonText(text: string, query: string): { matches: JsonRange[]; capped: boolean } {
  const matches: JsonRange[] = [];
  if (!query) return { matches, capped: false };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  for (const match of text.matchAll(expression)) {
    if (matches.length === 1000) return { matches, capped: true };
    matches.push({ from: match.index!, to: match.index! + match[0].length });
  }
  return { matches, capped: false };
}
