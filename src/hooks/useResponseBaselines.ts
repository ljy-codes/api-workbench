import { useState } from 'react';

export interface ResponseBaseline { body: string; savedAt: number }
const memoryLimit = 16 * 1024 * 1024;

/** Session only; the App owns this hook so response-panel remounts cannot lose a baseline. */
export function useResponseBaselines(context: string) {
  const [baselines, setBaselines] = useState<Map<string, ResponseBaseline>>(() => new Map());
  const forgetBaseline = (key: string) => setBaselines(previous => {
    const next = new Map(previous); next.delete(key); return next;
  });
  return {
    baseline: baselines.get(context),
    saveBaseline(body: string): boolean {
      if (body.length * 2 > memoryLimit) return false;
      setBaselines(previous => {
        const next = new Map(previous);
        next.delete(context);
        next.set(context, { body, savedAt: Date.now() });
        let size = [...next.values()].reduce((total, entry) => total + entry.body.length * 2, 0);
        while (next.size > 8 || size > memoryLimit) {
          const oldest = next.keys().next().value!;
          size -= next.get(oldest)!.body.length * 2;
          next.delete(oldest);
        }
        return next;
      });
      return true;
    },
    clearBaseline() { forgetBaseline(context); },
    forgetBaseline,
  };
}
