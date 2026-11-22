export const MAX_CLOSED_TABS = 20;

export interface ClosedTab {
  projectId: string;
  requestId: string;
  index: number;
}

export interface ClosedTabCleanup {
  projectId: string;
  requestIds: Set<string>;
  openTabs: Set<string>;
}

/**
 * Add a batch of tabs as one close action. The last item in the closed range
 * is restored first, matching the user's visual close order.
 */
export function addClosedTabs(existing: ClosedTab[], closing: ClosedTab[]): ClosedTab[] {
  if (!closing.length) return existing;
  return [...closing].reverse().concat(existing).slice(0, MAX_CLOSED_TABS);
}

export function nextClosedTab(entries: ClosedTab[], projectId: string): { entry: ClosedTab; rest: ClosedTab[] } | null {
  const index = entries.findIndex(entry => entry.projectId === projectId);
  if (index < 0) return null;
  return { entry: entries[index], rest: entries.slice(0, index).concat(entries.slice(index + 1)) };
}

export function discardClosedTab(entries: ClosedTab[], projectId: string, requestId: string): ClosedTab[] {
  return entries.filter(entry => entry.projectId !== projectId || entry.requestId !== requestId);
}

export function removeInvalidClosedTabs(entries: ClosedTab[], cleanup: ClosedTabCleanup): ClosedTab[] {
  return entries.filter(entry => {
    if (entry.projectId !== cleanup.projectId) return true;
    return cleanup.requestIds.has(entry.requestId) && !cleanup.openTabs.has(entry.requestId);
  });
}
