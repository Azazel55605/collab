import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SAVED_KEY = 'collab-hosted-server-url';
const mocks = vi.hoisted(() => ({
  statuses: {} as Record<string, unknown>,
  subscribers: new Set<() => void>(),
  autoReconnect: vi.fn().mockResolvedValue('failed'),
  loadHostedVaults: vi.fn().mockResolvedValue(undefined),
  syncAllForServer: vi.fn().mockResolvedValue(undefined),
}));
const { subscribers, autoReconnect, loadHostedVaults, syncAllForServer } = mocks;

vi.mock('../store/serverStore', () => ({
  isEffectivelyConnected: (status: { connected?: boolean; serverUrl?: string } | null) =>
    !!status?.connected && !!status?.serverUrl,
  shouldRefreshServerSession: (status: { connected?: boolean; serverUrl?: string; refreshSoon?: boolean } | null) =>
    !status?.connected || status.refreshSoon === true,
  useServerStore: {
    getState: () => ({
      statusFor: (serverUrl: string) => mocks.statuses[serverUrl] ?? null,
      autoReconnect: mocks.autoReconnect,
      loadHostedVaults: mocks.loadHostedVaults,
    }),
    subscribe: (listener: () => void) => {
      mocks.subscribers.add(listener);
      return () => mocks.subscribers.delete(listener);
    },
  },
}));

// The reconnect loop iterates the known-servers list; derive a single saved
// server from the legacy key so the existing test bodies stay simple.
vi.mock('../lib/hostedServers', () => ({
  listKnownServers: () => {
    const url = localStorage.getItem(SAVED_KEY);
    return url
      ? [{ serverUrl: url, username: '', allowInvalidCertificates: false, persistAcrossReboots: false }]
      : [];
  },
}));

vi.mock('../store/syncStore', () => ({
  useSyncStore: { getState: () => ({ syncAllForServer: mocks.syncAllForServer }) },
}));

import { AUTO_RECONNECT_INTERVAL_MS, useServerAutoReconnect } from './useServerAutoReconnect';

const CONNECTED = { connected: true, serverUrl: 'https://collab.example.test' };
const NEAR_EXPIRY = { ...CONNECTED, refreshSoon: true };

function setConnected() {
  mocks.statuses[CONNECTED.serverUrl] = CONNECTED;
}

function emitStoreChange() {
  for (const listener of [...subscribers]) listener();
}

function Harness() {
  useServerAutoReconnect();
  return null;
}

const flush = () => act(async () => { await Promise.resolve(); });

describe('useServerAutoReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoReconnect.mockResolvedValue('failed');
    syncAllForServer.mockResolvedValue(undefined);
    subscribers.clear();
    mocks.statuses = {};
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does nothing when there is no saved session', async () => {
    render(<Harness />);
    await flush();
    expect(autoReconnect).not.toHaveBeenCalled();
    expect(syncAllForServer).not.toHaveBeenCalled();
  });

  it('attempts a reconnect on mount while a saved session is disconnected', async () => {
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    render(<Harness />);
    await flush();
    expect(autoReconnect).toHaveBeenCalledWith(CONNECTED.serverUrl);
    expect(syncAllForServer).not.toHaveBeenCalled();
  });

  it('does not attempt a reconnect when already effectively connected', async () => {
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    setConnected();
    render(<Harness />);
    await flush();
    expect(autoReconnect).not.toHaveBeenCalled();
    expect(loadHostedVaults).toHaveBeenCalledWith(CONNECTED.serverUrl, { quiet: true });
  });

  it('refreshes proactively when an effective connection is close to expiry', async () => {
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    mocks.statuses[CONNECTED.serverUrl] = NEAR_EXPIRY;
    render(<Harness />);
    await flush();
    expect(autoReconnect).toHaveBeenCalledWith(CONNECTED.serverUrl);
  });

  it('syncs all of the server\'s replicas when the connection is (re)established', async () => {
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    render(<Harness />);
    await flush();
    expect(syncAllForServer).not.toHaveBeenCalled();

    // The session comes back (by this loop or a manual reconnect): a store change
    // fires, and the rising edge triggers the automatic sync exactly once.
    setConnected();
    await act(async () => {
      emitStoreChange();
      await Promise.resolve();
    });
    expect(syncAllForServer).toHaveBeenCalledWith(CONNECTED.serverUrl);

    // A subsequent unrelated store change does not re-sync (no new rising edge).
    await act(async () => {
      emitStoreChange();
      await Promise.resolve();
    });
    expect(syncAllForServer).toHaveBeenCalledTimes(1);
  });

  it('contains a rejected background sync after reconnect', async () => {
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    syncAllForServer.mockRejectedValueOnce(new Error('replica refresh failed'));
    render(<Harness />);
    await flush();

    setConnected();
    await act(async () => {
      emitStoreChange();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(syncAllForServer).toHaveBeenCalledWith(CONNECTED.serverUrl);
  });

  it('keeps retrying on the interval while disconnected', async () => {
    vi.useFakeTimers();
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(autoReconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(AUTO_RECONNECT_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(autoReconnect).toHaveBeenCalledTimes(2);
  });

  it('refreshes connected server inventories on the interval', async () => {
    vi.useFakeTimers();
    localStorage.setItem(SAVED_KEY, CONNECTED.serverUrl);
    setConnected();
    render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(loadHostedVaults).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(AUTO_RECONNECT_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(loadHostedVaults).toHaveBeenCalledTimes(2);
  });
});
