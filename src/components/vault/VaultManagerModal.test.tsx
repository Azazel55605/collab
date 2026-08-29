import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { HostedVaultMeta, HostedVaultSummary, LocalVaultMeta } from '../../types/vault';

import VaultManagerModal from './VaultManagerModal';

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    showOpenVaultDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    renameVault: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const syncStoreMock = vi.hoisted(() => ({
  makeAvailableOffline: vi.fn(),
  offlineAvailableAt: null as string | null,
}));

const replicaMock = vi.hoisted(() => ({
  listHostedVaultReplicas: vi.fn(),
  deleteHostedVaultReplica: vi.fn(),
}));

vi.mock('../../store/syncStore', () => ({
  syncRollup: () => 'synced',
  useSyncStore: () => ({
    status: 'idle',
    lastSyncedAt: '2026-06-18T00:00:00Z',
    offlineAvailableAt: syncStoreMock.offlineAvailableAt,
    pending: [],
    failed: [],
    access: 'ok',
    isSyncing: false,
    refresh: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    makeAvailableOffline: syncStoreMock.makeAvailableOffline,
    removeReplica: vi.fn(async () => {}),
  }),
}));

vi.mock('../../lib/vaultReplica', () => ({
  listHostedVaultReplicas: replicaMock.listHostedVaultReplicas,
  deleteHostedVaultReplica: replicaMock.deleteHostedVaultReplica,
}));

// The manager modal builds a VaultClient per row; stub it so local rows do not hit Tauri.
vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({ runtime: {} }),
  hasRuntimeCapability: () => false,
  requireRuntimeCapability: () => ({ exportTo: vi.fn() }),
}));

const hostedVault: HostedVaultSummary = {
  id: 'vault-1',
  name: 'Team Vault',
  ownerUserId: 'user-1',
  ownerDisplayName: 'Alice',
  role: 'editor',
  status: 'active',
  manifestSequence: 1,
  members: 3,
  storageBytes: 100,
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T09:00:00Z',
};

const localVault: LocalVaultMeta = {
  kind: 'local',
  id: 'local-1',
  name: 'My Local Vault',
  path: '/vaults/local',
  lastOpened: 1,
  isEncrypted: false,
};

const openHostedVaultMeta: HostedVaultMeta = {
  ...hostedVault,
  kind: 'hosted',
  hostedVaultId: hostedVault.id,
  id: `hosted:${hostedVault.id}`,
  serverUrl: 'https://collab.example.test',
  path: `hosted://${hostedVault.id}`,
  lastOpened: 1,
  isEncrypted: false,
};

const openHostedVault = vi.fn(async () => {});
const createHostedVault = vi.fn(async () => hostedVault);

function connect(connected: boolean) {
  useServerStore.setState({
    connections: connected
      ? {
          'https://collab.example.test': {
            status: {
              connected: true,
              serverUrl: 'https://collab.example.test',
              allowInvalidCertificates: false,
              user: {
                id: 'user-1',
                username: 'alice',
                displayName: 'Alice',
                role: 'member',
                status: 'active',
              },
              accessExpiresAt: '2999-01-01T00:00:00Z',
            },
            hostedVaults: [hostedVault],
          },
        }
      : {},
    isLoading: false,
    error: null,
    refreshAll: vi.fn(async () => {}),
    loadHostedVaults: vi.fn(async () => {}),
    createHostedVault,
  } as never);
}

describe('VaultManagerModal hosted vaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStoreMock.offlineAvailableAt = null;
    replicaMock.listHostedVaultReplicas.mockResolvedValue([]);
    replicaMock.deleteHostedVaultReplica.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    useUiStore.setState({ isVaultManagerOpen: true, closeVaultManager: vi.fn() } as never);
    useVaultStore.setState({
      vault: localVault,
      recentVaults: [localVault],
      openVault: vi.fn(async () => {}),
      openHostedVault,
      loadRecentVaults: vi.fn(async () => {}),
      removeRecentVault: vi.fn(async () => {}),
      closeVault: vi.fn(),
    } as never);
  });

  it('lists hosted vaults from the connected server alongside local vaults', async () => {
    connect(true);
    render(<VaultManagerModal />);
    expect(await screen.findByText('Team Vault')).not.toBeNull();
    expect(screen.getByText('My Local Vault')).not.toBeNull();
  });

  it('opens a hosted vault with server-backed metadata', async () => {
    connect(true);
    render(<VaultManagerModal />);
    fireEvent.click(await screen.findByTitle('Open hosted vault'));
    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'hosted',
          hostedVaultId: 'vault-1',
          serverUrl: 'https://collab.example.test',
          role: 'editor',
        }),
      ),
    );
  });

  it('does not show a hosted section when disconnected', () => {
    connect(false);
    render(<VaultManagerModal />);
    expect(screen.queryByText('Team Vault')).toBeNull();
    expect(screen.getByText('My Local Vault')).not.toBeNull();
  });

  it('creates a hosted vault from the manager and opens it', async () => {
    connect(true);
    render(<VaultManagerModal />);
    fireEvent.click(await screen.findByTitle('New hosted vault'));
    fireEvent.change(screen.getByPlaceholderText('New hosted vault name'), {
      target: { value: 'Fresh Vault' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(createHostedVault).toHaveBeenCalledWith('https://collab.example.test', 'Fresh Vault'),
    );
    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'hosted', hostedVaultId: 'vault-1' }),
      ),
    );
  });

  it('exposes hosted offline sync controls and starts the offline cache action', async () => {
    connect(true);
    syncStoreMock.makeAvailableOffline.mockResolvedValue({
      documentsCached: 1,
      assetsCached: 2,
      skipped: 0,
    });
    useVaultStore.setState({ vault: openHostedVaultMeta } as never);
    render(<VaultManagerModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Offline Sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make available offline' }));

    await waitFor(() =>
      expect(syncStoreMock.makeAvailableOffline).toHaveBeenCalledWith(
        openHostedVaultMeta,
        expect.any(Function),
      ),
    );
  });

  it('disables offline copy creation once the hosted vault is already available offline', async () => {
    syncStoreMock.offlineAvailableAt = '2026-06-18T00:05:00Z';
    useVaultStore.setState({ vault: openHostedVaultMeta } as never);
    render(<VaultManagerModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Offline Sync' }));

    const button = screen.getByRole('button', { name: 'Offline copy ready' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('lists offline hosted copies from multiple servers and opens one', async () => {
    connect(false);
    replicaMock.listHostedVaultReplicas.mockResolvedValue([
      {
        serverUrl: 'https://server-one.test',
        vaultId: 'vault-a',
        vaultName: 'Alpha Offline',
        manifestSequence: 4,
        lastSyncedAt: '2026-06-21T10:00:00Z',
        status: 'offline',
        pendingCount: 1,
        updatedAt: '2026-06-21T10:00:00Z',
        role: 'editor',
        capabilities: ['vault.read', 'file.write'],
      },
      {
        serverUrl: 'https://server-two.test',
        vaultId: 'vault-b',
        vaultName: 'Beta Offline',
        manifestSequence: 5,
        lastSyncedAt: null,
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-20T10:00:00Z',
        role: 'admin',
        capabilities: ['vault.read'],
      },
    ]);
    render(<VaultManagerModal />);

    expect(await screen.findByText('Offline copies · https://server-one.test')).toBeTruthy();
    expect(screen.getByText('Offline copies · https://server-two.test')).toBeTruthy();
    fireEvent.click(screen.getAllByTitle('Open hosted vault')[0]);

    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'hosted',
          hostedVaultId: 'vault-a',
          serverUrl: 'https://server-one.test',
          role: 'editor',
          capabilities: ['vault.read', 'file.write'],
        }),
      ),
    );
  });

  it('removes a stale offline hosted copy and refreshes the list', async () => {
    connect(false);
    const staleReplica = {
      serverUrl: 'https://dead-server.test',
      vaultId: 'vault-stale',
      vaultName: 'Stale Offline',
      manifestSequence: 1,
      lastSyncedAt: null,
      status: 'idle',
      pendingCount: 0,
      updatedAt: '2026-06-20T10:00:00Z',
      role: 'viewer',
      capabilities: [],
    };
    replicaMock.listHostedVaultReplicas
      .mockResolvedValueOnce([staleReplica])
      .mockResolvedValueOnce([]);
    render(<VaultManagerModal />);

    expect(await screen.findByText('Stale Offline')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Remove offline copy'));

    await waitFor(() =>
      expect(replicaMock.deleteHostedVaultReplica).toHaveBeenCalledWith(staleReplica),
    );
    await waitFor(() => expect(screen.queryByText('Stale Offline')).toBeNull());
  });
});
