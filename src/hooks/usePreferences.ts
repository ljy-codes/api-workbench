import { useSyncExternalStore } from 'react';
import {
  DEFAULT_PREFERENCES, getPreferences, subscribePreferences, updatePreferences,
} from '../lib/preferences';

export type { Preferences, ThemeMode } from '../lib/preferences';

export function usePreferences() {
  const preferences = useSyncExternalStore(
    subscribePreferences, getPreferences, () => DEFAULT_PREFERENCES,
  );
  return { preferences, updatePreferences };
}
