import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_SNAPSHOT_INTERVAL_MS, useDocumentSessionState } from './documentSession';

describe('useDocumentSessionState', () => {
  it('skips autosave once after load and again after a reload', () => {
    const { result } = renderHook(() => useDocumentSessionState());

    result.current.markLoaded('hash-1');
    expect(result.current.shouldSkipAutosave()).toBe(true);
    expect(result.current.shouldSkipAutosave()).toBe(false);

    result.current.markLoaded('hash-2');
    expect(result.current.shouldSkipAutosave()).toBe(true);
    expect(result.current.shouldSkipAutosave()).toBe(false);
  });

  it('tracks the latest loaded hash', () => {
    const { result } = renderHook(() => useDocumentSessionState());

    result.current.markLoaded('hash-1');
    expect(result.current.hashRef.current).toBe('hash-1');

    result.current.markLoaded(null);
    expect(result.current.hashRef.current).toBeUndefined();
  });

  it('creates snapshots only when the hash changes and the interval has elapsed', () => {
    const { result } = renderHook(() => useDocumentSessionState());
    const now = 1_000_000;

    expect(result.current.shouldCreateSnapshot('hash-1', now)).toBe(true);
    expect(
      result.current.shouldCreateSnapshot('hash-1', now + DOCUMENT_SNAPSHOT_INTERVAL_MS + 1),
    ).toBe(false);
    expect(result.current.shouldCreateSnapshot('hash-2', now + 1)).toBe(false);
    expect(
      result.current.shouldCreateSnapshot('hash-2', now + DOCUMENT_SNAPSHOT_INTERVAL_MS + 1),
    ).toBe(true);
  });

  describe('runExclusiveSave', () => {
    it('never runs two saves concurrently', async () => {
      const { result } = renderHook(() => useDocumentSessionState());
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
      let inFlight = 0;
      let maxConcurrent = 0;
      const release: Array<() => void> = [];
      const makeSave = () => () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        });

      const first = result.current.runExclusiveSave(makeSave());
      // A second request while the first is in flight must not start a save yet.
      result.current.runExclusiveSave(makeSave());
      expect(release).toHaveLength(1);

      release[0](); // finish the first save → the coalesced one starts
      await flush();
      expect(release).toHaveLength(2);
      release[1]();
      await first;

      expect(maxConcurrent).toBe(1);
    });

    it('coalesces multiple in-flight requests into a single trailing save (latest wins)', async () => {
      const { result } = renderHook(() => useDocumentSessionState());
      const order: string[] = [];
      let releaseFirst!: () => void;

      const firstSave = () =>
        new Promise<void>((resolve) => {
          order.push('first');
          releaseFirst = resolve;
        });
      const staleSave = () => {
        order.push('stale');
        return Promise.resolve();
      };
      const latestSave = () => {
        order.push('latest');
        return Promise.resolve();
      };

      const run = result.current.runExclusiveSave(firstSave);
      // Two requests arrive during the in-flight first save; only the last should run.
      result.current.runExclusiveSave(staleSave);
      result.current.runExclusiveSave(latestSave);

      releaseFirst();
      await run;
      await Promise.resolve();

      expect(order).toEqual(['first', 'latest']);
    });
  });
});
