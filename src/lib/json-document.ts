export interface JsonDocument {
  validJson: boolean;
  formatted: string;
  value?: unknown;
  notice?: string;
}
export function prepareJsonDocument(raw: string): JsonDocument {
  try {
    const value: unknown = JSON.parse(raw);
    try { return { validJson: true, value, formatted: JSON.stringify(value, null, 2) }; }
    catch { return { validJson: false, formatted: raw, notice: 'JSON 嵌套过深，已保留原文。' }; }
  } catch { return { validJson: false, formatted: raw }; }
}
