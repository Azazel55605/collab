import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFullscreenMediaDock } from './useFullscreenMediaDock';

describe('useFullscreenMediaDock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides controls after an idle period while auto-hide is on, and reveals on activity', () => {
    const { result } = renderHook(() => useFullscreenMediaDock(true, false));
    expect(result.current.show).toBe(true);

    act(() => vi.advanceTimersByTime(2300));
    expect(result.current.show).toBe(false);

    act(() => result.current.reveal());
    expect(result.current.show).toBe(true);
  });

  it('keeps controls visible while paused, on error, or with a menu open', () => {
    const paused = renderHook(() => useFullscreenMediaDock(false, false));
    act(() => vi.advanceTimersByTime(5000));
    expect(paused.result.current.show).toBe(true);

    const failing = renderHook(() => useFullscreenMediaDock(true, true));
    act(() => vi.advanceTimersByTime(5000));
    expect(failing.result.current.show).toBe(true);

    const menu = renderHook(() => useFullscreenMediaDock(true, false));
    act(() => menu.result.current.onMenuOpenChange(true));
    act(() => vi.advanceTimersByTime(5000));
    expect(menu.result.current.show).toBe(true);
  });
});
