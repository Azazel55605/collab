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
    expect(result.current.shouldCreateSnapshot('hash-1', now + DOCUMENT_SNAPSHOT_INTERVAL_MS + 1)).toBe(false);
    expect(result.current.shouldCreateSnapshot('hash-2', now + 1)).toBe(false);
    expect(result.current.shouldCreateSnapshot('hash-2', now + DOCUMENT_SNAPSHOT_INTERVAL_MS + 1)).toBe(true);
  });
});
