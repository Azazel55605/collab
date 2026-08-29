import { useCallback, useRef } from 'react';

import { createExclusiveSaveRunner } from './documentSessionController';

export const DOCUMENT_SNAPSHOT_INTERVAL_MS = 60_000;

export function useDocumentSessionState() {
  const hashRef = useRef<string | undefined>(undefined);
  const lastWriteRef = useRef(0);
  const skipNextAutosaveRef = useRef(true);
  const lastSnapshotHashRef = useRef<string | null>(null);
  const lastSnapshotTimeRef = useRef(0);
  // The trailing-coalescing serial save primitive now lives in the shared
  // document session controller; this legacy hook wraps it so both the old
  // per-view state and the new controller share one implementation.
  const runnerRef = useRef<ReturnType<typeof createExclusiveSaveRunner> | null>(null);
  if (runnerRef.current === null) runnerRef.current = createExclusiveSaveRunner();

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

  const shouldCreateSnapshot = useCallback(
    (hash: string, now = Date.now(), intervalMs = DOCUMENT_SNAPSHOT_INTERVAL_MS) => {
      if (hash === lastSnapshotHashRef.current) return false;
      if (now - lastSnapshotTimeRef.current < intervalMs) return false;
      lastSnapshotHashRef.current = hash;
      lastSnapshotTimeRef.current = now;
      return true;
    },
    [],
  );

  /**
   * Runs document saves one at a time, coalescing overlapping requests to the
   * latest content. See {@link createExclusiveSaveRunner} for the full rationale.
   */
  const runExclusiveSave = useCallback(
    (save: () => Promise<void>) => runnerRef.current!.run(save),
    [],
  );

  return {
    hashRef,
    lastWriteRef,
    markLoaded,
    shouldSkipAutosave,
    markWriteStarted,
    shouldCreateSnapshot,
    runExclusiveSave,
  };
}
