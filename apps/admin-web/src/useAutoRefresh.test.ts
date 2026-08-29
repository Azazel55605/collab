import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoRefresh } from './useAutoRefresh';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not load on mount (the page owns initial load)', () => {
    const load = vi.fn();
    renderHook(() => useAutoRefresh(load, { intervalMs: 1000 }));
    expect(load).not.toHaveBeenCalled();
  });

  it('polls on the interval while the tab is visible', () => {
    const load = vi.fn();
    renderHook(() => useAutoRefresh(load, { intervalMs: 1000 }));
    vi.advanceTimersByTime(3000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('skips polling while the tab is hidden, and refreshes when it returns', () => {
    const load = vi.fn();
    renderHook(() => useAutoRefresh(load, { intervalMs: 1000 }));
    setVisibility('hidden');
    vi.advanceTimersByTime(3000);
    expect(load).not.toHaveBeenCalled();
    setVisibility('visible'); // visibilitychange -> immediate refresh
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately on window focus', () => {
    const load = vi.fn();
    renderHook(() => useAutoRefresh(load, { intervalMs: 100_000 }));
    window.dispatchEvent(new Event('focus'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('always calls the latest load callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useAutoRefresh(cb, { intervalMs: 1000 }), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const load = vi.fn();
    renderHook(() => useAutoRefresh(load, { intervalMs: 1000, enabled: false }));
    vi.advanceTimersByTime(3000);
    window.dispatchEvent(new Event('focus'));
    expect(load).not.toHaveBeenCalled();
  });
});
