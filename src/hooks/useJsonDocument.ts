import { useEffect, useMemo, useState } from 'react';
import { prepareJsonDocument, type JsonDocument } from '../lib/json-document';

const workerThreshold = 256 * 1024;
type Prepared = JsonDocument & { loading: boolean };
const original = (raw: string): Prepared => ({
  validJson: false, formatted: raw, loading: false,
  notice: '后台 JSON 处理不可用，已保留原文。',
});

/** Small responses stay immediate; large parse/stringify work cannot block typing. */
export function useJsonDocument(raw: string): Prepared {
  const immediate = useMemo<Prepared | null>(() =>
    raw.length < workerThreshold ? { ...prepareJsonDocument(raw), loading: false } : null, [raw]);
  const [completed, setCompleted] = useState<{ raw: string; document: Prepared } | null>(null);
  const canWork = typeof Worker !== 'undefined';
  useEffect(() => {
    if (immediate || !canWork) return;
    let active = true;
    let worker: Worker | undefined;
    const fail = () => {
      if (active) setCompleted({ raw, document: original(raw) });
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('../lib/json-response.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<JsonDocument>) => {
        if (active) setCompleted({ raw, document: { ...event.data, loading: false } });
        worker?.terminate();
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.postMessage(raw);
    } catch { fail(); }
    return () => { active = false; worker?.terminate(); };
  }, [raw, immediate, canWork]);
  if (immediate) return immediate;
  if (!canWork) return original(raw);
  if (completed?.raw === raw) return completed.document;
  return { validJson: false, formatted: '', loading: true };
}
