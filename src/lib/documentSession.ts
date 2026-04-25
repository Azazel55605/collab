import { useCallback, useRef } from 'react';

export const DOCUMENT_SNAPSHOT_INTERVAL_MS = 60_000;

export function useDocumentSessionState() {
  const hashRef = useRef<string | undefined>(undefined);
  const lastWriteRef = useRef(0);
  const skipNextAutosaveRef = useRef(true);
  const lastSnapshotHashRef = useRef<string | null>(null);
  const lastSnapshotTimeRef = useRef(0);

  const markLoaded = useCallback((hash?: string | null) => {
    hashRef.current = hash ?? undefined;
    skipNextAutosaveRef.current = true;
  }, []);

  const shouldSkipAutosave = useCallback(() => {
    if (!skipNextAutosaveRef.current) return false;
    skipNextAutosaveRef.current = false;
    return true;
  }, []);

  const markWriteStarted = useCallback(() => {
    lastWriteRef.current = Date.now();
  }, []);

  const shouldCreateSnapshot = useCallback((hash: string, now = Date.now(), intervalMs = DOCUMENT_SNAPSHOT_INTERVAL_MS) => {
    if (hash === lastSnapshotHashRef.current) return false;
    if (now - lastSnapshotTimeRef.current < intervalMs) return false;
    lastSnapshotHashRef.current = hash;
    lastSnapshotTimeRef.current = now;
    return true;
  }, []);

  return {
    hashRef,
    lastWriteRef,
    markLoaded,
    shouldSkipAutosave,
    markWriteStarted,
    shouldCreateSnapshot,
  };
}
