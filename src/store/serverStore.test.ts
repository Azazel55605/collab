import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriCommands } from '../lib/tauri';
import {
  useServerStore,
  isServerSessionExpired,
  isEffectivelyConnected,
  shouldRefreshServerSession,
  type ServerConnection,
} from './serverStore';
import { useVaultStore } from './vaultStore';
import { useSyncStore } from './syncStore';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    serverConnectionStatuses: vi.fn(),
    serverHasSavedSession: vi.fn(),
    connectServer: vi.fn(),
    reauthenticateServer: vi.fn(),
    reconnectServer: vi.fn(),
    disconnectServer: vi.fn(),
    hostedVaultRequest: vi.fn(),
    backgroundServerReplace: vi.fn().mockResolvedValue([]),
  },
}));

const SERVER_URL = 'https://collab.example.test';

const connected = {
  connected: true,
  serverUrl: SERVER_URL,
  allowInvalidCertificates: false,
  user: { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'member' as const, status: 'active' as const },
  accessExpiresAt: '2999-01-01T00:00:00Z',
};

const hostedVault = {
  id: 'vault-1',
  name: 'Hosted Vault',
  ownerUserId: 'user-1',
  ownerDisplayName: 'Alice',
  role: 'admin' as const,
  status: 'active' as const,
  manifestSequence: 1,
  members: 1,
  storageBytes: 0,
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T08:00:00Z',
};

/** Seeds the store with a single connected server's connection. */
function seed(status = connected, hostedVaults: typeof hostedVault[] = []): Record<string, ServerConnection> {
  return { [status.serverUrl!]: { status, hostedVaults } };
}

describe('serverStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useServerStore.setState({ connections: {}, isLoading: false, error: null });
    useVaultStore.setState({ vault: null, fileTree: [], isLoading: false } as never);
  });

  it('refreshes the native sessions and lists hosted vaults per server', async () => {
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([connected]);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    await useServerStore.getState().refreshAll();

    expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(SERVER_URL, 'GET', '/api/v1/vaults');
  });

  it('removes only the disconnected server, leaving others', async () => {
    const other = { ...connected, serverUrl: 'https://other.example.test' };
    useServerStore.setState({ connections: { ...seed(connected, [hostedVault]), ...seed(other) } });
    vi.mocked(tauriCommands.disconnectServer).mockResolvedValue();

    await useServerStore.getState().disconnect(SERVER_URL);

    expect(tauriCommands.disconnectServer).toHaveBeenCalledWith(SERVER_URL);
    expect(useServerStore.getState().connectionFor(SERVER_URL)).toBeUndefined();
    expect(useServerStore.getState().statusFor('https://other.example.test')).toEqual(other);
  });

  it('creates a hosted vault on the target server and refreshes its inventory', async () => {
    useServerStore.setState({ connections: seed() });
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(hostedVault) // POST /api/v1/vaults
      .mockResolvedValueOnce([hostedVault]); // GET reload

    const created = await useServerStore.getState().createHostedVault(SERVER_URL, 'New Vault');

    expect(created).toEqual(hostedVault);
    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(SERVER_URL, 'POST', '/api/v1/vaults', { name: 'New Vault' });
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
  });

  it('refreshes the currently open hosted vault role and capabilities', async () => {
    useServerStore.setState({ connections: seed() });
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'vault-1',
        hostedVaultId: 'vault-1',
        serverUrl: SERVER_URL,
        name: 'Hosted Vault',
        path: 'hosted://vault-1',
        lastOpened: 1,
        isEncrypted: false,
        role: 'viewer',
        capabilities: ['vault.read'],
      },
    } as never);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([{
      ...hostedVault,
      role: 'editor',
      capabilities: ['vault.read', 'file.write', 'kanban.card.move'],
      updatedAt: '2026-06-11T09:00:00Z',
    }]);

    await useServerStore.getState().loadHostedVaults(SERVER_URL);

    expect(useVaultStore.getState().vault).toMatchObject({
      role: 'editor',
      capabilities: ['vault.read', 'file.write', 'kanban.card.move'],
    });
  });

  it('uses refreshed manifest sequences to schedule offline-copy updates', async () => {
    useServerStore.setState({ connections: seed() });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);
    const refreshOfflineCopies = vi
      .spyOn(useSyncStore.getState(), 'refreshOfflineCopiesForServer')
      .mockResolvedValue(undefined);

    await useServerStore.getState().loadHostedVaults(SERVER_URL, { quiet: true });

    expect(refreshOfflineCopies).toHaveBeenCalledWith(SERVER_URL, [hostedVault]);
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
    refreshOfflineCopies.mockRestore();
  });

  it('does not let an older inventory request restore pre-reauthentication status', async () => {
    const oldStatus = { ...connected, accessExpiresAt: '2026-06-11T10:00:00Z' };
    const newStatus = { ...connected, accessExpiresAt: '2026-06-11T12:00:00Z' };
    useServerStore.setState({ connections: seed(oldStatus, [hostedVault]) });
    let resolveInventory!: (vaults: typeof hostedVault[]) => void;
    vi.mocked(tauriCommands.hostedVaultRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInventory = resolve;
      }),
    );

    const staleLoad = useServerStore.getState().loadHostedVaults(SERVER_URL, { quiet: true });
    useServerStore.setState({ connections: seed(newStatus, [hostedVault]) });
    resolveInventory([{ ...hostedVault, manifestSequence: 2 }]);
    await staleLoad;

    expect(useServerStore.getState().statusFor(SERVER_URL)).toBe(newStatus);
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
  });

  it('refuses to create a hosted vault when not connected to that server', async () => {
    useServerStore.setState({ connections: {} });
    await expect(useServerStore.getState().createHostedVault(SERVER_URL, 'X')).rejects.toThrow(/Connect to a Collab server/);
  });

  it('records a connected server in the known-servers list on connect', async () => {
    vi.mocked(tauriCommands.connectServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([]);

    await useServerStore.getState().connect(SERVER_URL, 'alice', 'pw', true, false);

    expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
    const known = JSON.parse(localStorage.getItem('collab-hosted-servers') ?? '[]');
    expect(known).toEqual([{ serverUrl: SERVER_URL, username: 'alice', allowInvalidCertificates: true, persistAcrossReboots: false }]);
  });

  it('reauthenticates with the saved server settings and reloads its vaults', async () => {
    localStorage.setItem('collab-hosted-servers', JSON.stringify([{
      serverUrl: SERVER_URL,
      username: 'alice',
      allowInvalidCertificates: true,
      persistAcrossReboots: true,
    }]));
    vi.mocked(tauriCommands.reauthenticateServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    await useServerStore.getState().reauthenticate(SERVER_URL, 'new-password');

    expect(tauriCommands.reauthenticateServer).toHaveBeenCalledWith(
      SERVER_URL,
      'alice',
      'new-password',
      true,
      true,
    );
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
  });

  it('keeps a successful reauthentication when inventory refresh is unavailable', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    vi.mocked(tauriCommands.reauthenticateServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValue(new Error('temporary outage'));

    await expect(
      useServerStore.getState().reauthenticate(SERVER_URL, 'new-password'),
    ).resolves.toBeUndefined();
    expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
  });

  it('uses the canonical server origin for saved reconnect state', async () => {
    localStorage.setItem('collab-hosted-servers', JSON.stringify([{
      serverUrl: `${SERVER_URL}/admin/`,
      username: 'alice',
      allowInvalidCertificates: false,
      persistAcrossReboots: false,
    }]));
    vi.mocked(tauriCommands.reauthenticateServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    await useServerStore.getState().reauthenticate(`${SERVER_URL}/admin/`, 'new-password');

    expect(tauriCommands.reauthenticateServer).toHaveBeenCalledWith(
      SERVER_URL,
      'alice',
      'new-password',
      false,
      false,
    );
    expect(useServerStore.getState().statusFor(`${SERVER_URL}/anything`)).toEqual(connected);
  });

  describe('autoReconnect', () => {
    it('skips when the server is not a known server', async () => {
      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('skipped');
      expect(tauriCommands.reconnectServer).not.toHaveBeenCalled();
    });

    it('is a quiet no-op when already effectively connected', async () => {
      localStorage.setItem('collab-hosted-server-url', SERVER_URL);
      useServerStore.setState({ connections: seed() });
      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('connected');
      expect(tauriCommands.reconnectServer).not.toHaveBeenCalled();
    });

    it('refreshes proactively when the access token is close to expiry', async () => {
      localStorage.setItem('collab-hosted-server-url', SERVER_URL);
      const nearExpiry = { ...connected, accessExpiresAt: new Date(Date.now() + 30_000).toISOString() };
      useServerStore.setState({ connections: seed(nearExpiry) });
      vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
      vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('connected');
      expect(tauriCommands.reconnectServer).toHaveBeenCalledWith(SERVER_URL, false, false);
      expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
    });

    it('reconnects from the saved refresh token and loads hosted vaults', async () => {
      localStorage.setItem('collab-hosted-server-url', SERVER_URL);
      vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
      vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('connected');
      expect(tauriCommands.reconnectServer).toHaveBeenCalledWith(SERVER_URL, false, false);
      expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
      expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
    });

    it('stays connected when only the post-reconnect inventory refresh fails', async () => {
      localStorage.setItem('collab-hosted-server-url', SERVER_URL);
      vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
      vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValue(new Error('temporary outage'));

      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('connected');
      expect(useServerStore.getState().statusFor(SERVER_URL)).toEqual(connected);
      expect(useServerStore.getState().error).toBeNull();
    });

    it('does not churn store state on a failed attempt', async () => {
      localStorage.setItem('collab-hosted-server-url', SERVER_URL);
      useServerStore.setState({ connections: {}, isLoading: false, error: null });
      vi.mocked(tauriCommands.reconnectServer).mockRejectedValue(new Error('could not reach server'));

      expect(await useServerStore.getState().autoReconnect(SERVER_URL)).toBe('failed');
      expect(useServerStore.getState().isLoading).toBe(false);
      expect(useServerStore.getState().error).toBeNull();
    });
  });

  it('refuses to create a hosted vault when the session has expired', async () => {
    useServerStore.setState({ connections: seed({ ...connected, accessExpiresAt: '2000-01-01T00:00:00Z' }) });
    await expect(useServerStore.getState().createHostedVault(SERVER_URL, 'X')).rejects.toThrow(/Connect to a Collab server/);
    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalled();
  });
});

describe('isEffectivelyConnected', () => {
  const now = Date.parse('2026-06-11T10:00:00Z');

  it('is true for a connected, unexpired session', () => {
    expect(isEffectivelyConnected({ ...connected, accessExpiresAt: '2026-06-11T12:00:00Z' }, now)).toBe(true);
  });

  it('is false when disconnected', () => {
    expect(isEffectivelyConnected(null, now)).toBe(false);
    expect(isEffectivelyConnected({ ...connected, connected: false }, now)).toBe(false);
  });

  it('is false when the access token has expired', () => {
    expect(isEffectivelyConnected({ ...connected, accessExpiresAt: '2026-06-11T09:00:00Z' }, now)).toBe(false);
  });
});

describe('shouldRefreshServerSession', () => {
  const now = Date.parse('2026-06-11T10:00:00Z');

  it('is true when disconnected or close to access-token expiry', () => {
    expect(shouldRefreshServerSession(null, now)).toBe(true);
    expect(shouldRefreshServerSession({ ...connected, connected: false }, now)).toBe(true);
    expect(shouldRefreshServerSession({ ...connected, accessExpiresAt: '2026-06-11T10:01:00Z' }, now)).toBe(true);
  });

  it('is false for a connected session with enough access-token lifetime left', () => {
    expect(shouldRefreshServerSession({ ...connected, accessExpiresAt: '2026-06-11T10:05:00Z' }, now)).toBe(false);
  });
});

describe('serverStore.restoreAllSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useServerStore.setState({ connections: {}, isLoading: false, error: null });
  });

  it('skips when no servers have been saved', async () => {
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    expect(await useServerStore.getState().restoreAllSessions()).toBe('skipped');
    expect(tauriCommands.reconnectServer).not.toHaveBeenCalled();
  });

  it('reuses a live in-memory session without reconnecting', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([connected]);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    expect(await useServerStore.getState().restoreAllSessions()).toBe('connected');
    expect(tauriCommands.backgroundServerReplace).toHaveBeenCalledWith([
      expect.objectContaining({
        serverUrl: SERVER_URL,
        backgroundSyncEnabled: true,
      }),
    ]);
    expect(tauriCommands.reconnectServer).not.toHaveBeenCalled();
    expect(useServerStore.getState().hostedVaultsFor(SERVER_URL)).toEqual([hostedVault]);
  });

  it('reconnects from the saved refresh token when no live session exists', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    localStorage.setItem('collab-hosted-allow-invalid-certificates', 'true');
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    expect(await useServerStore.getState().restoreAllSessions()).toBe('connected');
    expect(tauriCommands.reconnectServer).toHaveBeenCalledWith(SERVER_URL, true, false);
  });

  it('forwards the cross-reboot persistence preference to reconnect', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    localStorage.setItem('collab-hosted-persist-across-reboots', 'true');
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    expect(await useServerStore.getState().restoreAllSessions()).toBe('connected');
    expect(tauriCommands.reconnectServer).toHaveBeenCalledWith(SERVER_URL, false, true);
  });

  it('skips without error when a saved URL has no stored credential', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    vi.mocked(tauriCommands.reconnectServer).mockRejectedValue(new Error('No saved server session was found.'));

    expect(await useServerStore.getState().restoreAllSessions()).toBe('skipped');
    expect(tauriCommands.reconnectServer).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent restore attempts into a single reconnect', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    vi.mocked(tauriCommands.reconnectServer).mockResolvedValue(connected);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([hostedVault]);

    const store = useServerStore.getState();
    const [first, second] = await Promise.all([store.restoreAllSessions(), store.restoreAllSessions()]);

    expect(first).toBe('connected');
    expect(second).toBe('connected');
    expect(tauriCommands.reconnectServer).toHaveBeenCalledTimes(1);
  });

  it('reports failure when a stored credential exists but the reconnect fails', async () => {
    localStorage.setItem('collab-hosted-server-url', SERVER_URL);
    vi.mocked(tauriCommands.serverConnectionStatuses).mockResolvedValue([]);
    vi.mocked(tauriCommands.reconnectServer).mockRejectedValue(new Error('expired'));

    expect(await useServerStore.getState().restoreAllSessions()).toBe('failed');
  });
});

describe('isServerSessionExpired', () => {
  const now = Date.parse('2026-06-11T10:00:00Z');

  it('returns false when disconnected', () => {
    expect(isServerSessionExpired(null, now)).toBe(false);
    expect(isServerSessionExpired({ ...connected, connected: false }, now)).toBe(false);
  });

  it('returns false when the token is still valid', () => {
    expect(isServerSessionExpired({ ...connected, accessExpiresAt: '2026-06-11T12:00:00Z' }, now)).toBe(false);
  });

  it('returns true when the token has expired', () => {
    expect(isServerSessionExpired({ ...connected, accessExpiresAt: '2026-06-11T09:00:00Z' }, now)).toBe(true);
  });

  it('returns false when the expiry timestamp is absent or unparseable', () => {
    expect(isServerSessionExpired({ ...connected, accessExpiresAt: null }, now)).toBe(false);
    expect(isServerSessionExpired({ ...connected, accessExpiresAt: 'not-a-date' }, now)).toBe(false);
  });
});
