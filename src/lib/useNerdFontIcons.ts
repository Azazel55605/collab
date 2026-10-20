import { useEffect, useMemo, useState } from 'react';

import type { NerdFontIconEntry } from './nerdFontIcons';

type Registry = typeof import('./nerdFontIcons');
const EMPTY: NerdFontIconEntry[] = [];

/** Loading a note/canvas or the command shell must not parse/sort the glyph catalog. */
export function useNerdFontIcons(query: string, limit: number, enabled: boolean) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled || registry) return;
    let current = true;
    setError(false);
    void import('./nerdFontIcons').then(
      (loaded) => {
        if (current) setRegistry(loaded);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, registry]);
  const entries = useMemo(
    () => (enabled && registry ? registry.searchNerdFontIcons(query, limit) : EMPTY),
    [enabled, registry, query, limit],
  );
  return { entries, loading: enabled && !registry && !error, error };
}
