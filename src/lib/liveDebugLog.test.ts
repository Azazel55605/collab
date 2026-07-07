import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLiveDebugEvents,
  getLiveDebugEvents,
  isLiveCollabDebugEnabled,
  liveDebugPush,
  setLiveCollabDebug,
  subscribeLiveDebug,
} from './liveDebugLog';

describe('liveDebugLog', () => {
  beforeEach(() => {
    setLiveCollabDebug(false);
    clearLiveDebugEvents();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    setLiveCollabDebug(false);
    clearLiveDebugEvents();
    vi.restoreAllMocks();
  });

  it('drops events while disabled and records them once enabled', () => {
    liveDebugPush('file-1234', 'ignored while off');
    expect(getLiveDebugEvents()).toHaveLength(0);

    setLiveCollabDebug(true);
    expect(isLiveCollabDebugEnabled()).toBe(true);
    liveDebugPush('abcdef0123', 'send SYNC_UPDATE');

    const events = getLiveDebugEvents();
    expect(events).toHaveLength(1);
    // The file id is truncated to a short prefix for display.
    expect(events[0].file).toBe('abcdef01');
    expect(events[0].message).toBe('send SYNC_UPDATE');
  });

  it('returns a fresh snapshot reference on change (so React re-renders)', () => {
    setLiveCollabDebug(true);
    const before = getLiveDebugEvents();
    liveDebugPush('f', 'event');
    expect(getLiveDebugEvents()).not.toBe(before);
  });

  it('notifies subscribers on push and clear', () => {
    setLiveCollabDebug(true);
    const listener = vi.fn();
    const unsubscribe = subscribeLiveDebug(listener);

    liveDebugPush('f', 'one');
    clearLiveDebugEvents();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getLiveDebugEvents()).toHaveLength(0);

    unsubscribe();
    liveDebugPush('f', 'two');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
