import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../lib/tauri';
import {
  discardPendingOperation,
  listHostedVaultReplicas,
  listPendingOperationRecoveries,
  makeHostedVaultAvailableOffline,
  type PendingOperation,
  type PendingOperationRecovery,
  type ReplicaSummary,
  retryPendingOperation,
  syncReplicaManifestDelta,
} from '../lib/vaultReplica';
import type { HostedVaultMeta, HostedVaultSummary } from '../types/vault';

import { syncRollup, useSyncStore } from './syncStore';
import { useSyncTransferStore } from './syncTransferStore';
import { useVaultStore } from './vaultStore';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    replicaReadSyncState: vi.fn(),
    replicaListPendingOperations: vi.fn(),
    replicaDelete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../lib/vaultReplica', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vaultReplica')>();
  return {
    onReplicaMutated: vi.fn(() => () => {}),
    listPendingOperationRecoveries: vi.fn(),
    retryPendingOperation: vi.fn().mockResolvedValue(undefined),
    discardPendingOperation: vi.fn().mockResolvedValue(undefined),
    makeHostedVaultAvailableOffline: vi
      .fn()
      .mockResolvedValue({ documentsCached: 1, assetsCached: 2, skipped: 0 }),
    syncReplicaManifestDelta: vi.fn().mockResolvedValue({}),
    listHostedVaultReplicas: vi.fn().mockResolvedValue([]),
    // Use the real classifier/derivation/connectivity helpers.
    classifyVaultAccessError: actual.classifyVaultAccessError,
    deriveVaultAccess: actual.deriveVaultAccess,
    isLikelyConnectivityError: actual.isLikelyConnectivityError,
  };
});

const vault: HostedVaultMeta = {
  kind: 'hosted',
  id: 'vault-1',
  hostedVaultId: 'vault-1',
  serverUrl: 'https://collab.example.test',
  name: 'Team Vault',
  path: 'hosted://vault-1',
  lastOpened: 1,
  isEncrypted: false,
  role: 'editor',
};

const hostedSummary = (id: string, manifestSequence: number): HostedVaultSummary => ({
  id,
  name: id,
  ownerUserId: 'owner-1',
  ownerDisplayName: 'Owner',
  role: 'editor',
  status: 'active',
  manifestSequence,
  members: 1,
  storageBytes: 0,
  createdAt: '2026-06-18T00:00:00Z',
  updatedAt: '2026-06-18T00:00:00Z',
  capabilities: ['vault.read', 'vault.offlineCopy'],
});

function pending(id: string, status: PendingOperation['status'] = 'pending'): PendingOperation {
  return {
    id,
    kind: 'edit',
    fileId: 'f1',
    relativePath: 'Notes/a.md',
    payload: {},
    baseManifestSequence: 1,
    createdAt: '2026-06-18T00:00:00Z',
    status,
  };
}

function recovery(id: string): PendingOperationRecovery {
  return {
    operation: { ...pending(id, 'failed') },
    failure: { code: 'manifest_conflict', message: 'The vault manifest changed.' },
    recommendedAction: 'retry-after-refresh',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.getState().clear();
  useSyncTransferStore.getState().reset();
  vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
    manifestSequence: 3,
    lastSyncedAt: '2026-06-18T00:00:00Z',
    offlineAvailableAt: null,
    status: 'idle',
  });
  vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
  vi.mocked(listPendingOperationRecoveries).mockResolvedValue([]);
});

describe('syncRollup', () => {
  it('prioritizes conflicts over syncing, pending, and synced', () => {
    expect(
      syncRollup({
        isSyncing: true,
        status: 'syncing',
        pending: [pending('a')],
        failed: [recovery('b')],
      }),
    ).toBe('conflicts');
    expect(
      syncRollup({ isSyncing: true, status: 'idle', pending: [pending('a')], failed: [] }),
    ).toBe('syncing');
    expect(
      syncRollup({ isSyncing: false, status: 'offline', pending: [pending('a')], failed: [] }),
    ).toBe('pending');
    expect(syncRollup({ isSyncing: false, status: 'idle', pending: [], failed: [] })).toBe(
      'synced',
    );
  });
});

describe('syncStore', () => {
  it('refresh splits pending from failed operations', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      pending('a'),
      pending('b', 'inflight'),
      pending('c', 'failed'),
    ]);
    vi.mocked(listPendingOperationRecoveries).mockResolvedValue([recovery('c')]);

    await useSyncStore.getState().refresh(vault);

    const state = useSyncStore.getState();
    expect(state.pending.map((op) => op.id)).toEqual(['a', 'b']);
    expect(state.failed.map((r) => r.operation.id)).toEqual(['c']);
    expect(state.lastSyncedAt).toBe('2026-06-18T00:00:00Z');
    expect(state.offlineAvailableAt).toBeNull();
  });

  it('syncAllForServer replays every replica belonging to the server', async () => {
    useVaultStore.setState({ vault: null } as never);
    useSyncStore.setState({ isSyncing: false });
    const summary = (serverUrl: string, vaultId: string): ReplicaSummary => ({
      serverUrl,
      vaultId,
      vaultName: vaultId,
      manifestSequence: 1,
      lastSyncedAt: null,
      offlineAvailableAt: null,
      status: 'offline',
      pendingCount: 1,
      updatedAt: '2026-06-18T00:00:00Z',
      capabilities: [],
    });
    vi.mocked(listHostedVaultReplicas).mockResolvedValue([
      summary('https://a.test', 'v1'),
      summary('https://a.test', 'v2'),
      summary('https://b.test', 'v3'),
    ]);

    await useSyncStore.getState().syncAllForServer('https://a.test');

    const synced = vi.mocked(syncReplicaManifestDelta).mock.calls.map(([v]) => v.hostedVaultId);
    expect(synced).toEqual(['v1', 'v2']);
    expect(synced).not.toContain('v3');
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it('syncAllForServer is a no-op when the server has no replicas', async () => {
    useVaultStore.setState({ vault: null } as never);
    useSyncStore.setState({ isSyncing: false });
    vi.mocked(listHostedVaultReplicas).mockResolvedValue([]);

    await useSyncStore.getState().syncAllForServer('https://a.test');
    expect(syncReplicaManifestDelta).not.toHaveBeenCalled();
  });

  it('refreshes stale full offline copies from the latest server inventory', async () => {
    useVaultStore.setState({ vault: null } as never);
    vi.mocked(listHostedVaultReplicas).mockResolvedValue([
      {
        serverUrl: 'https://a.test',
        vaultId: 'stale',
        vaultName: 'Stale',
        manifestSequence: 3,
        lastSyncedAt: null,
        offlineAvailableAt: '2026-06-18T00:05:00Z',
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-18T00:00:00Z',
        capabilities: ['vault.read', 'vault.offlineCopy'],
      },
      {
        serverUrl: 'https://a.test',
        vaultId: 'current',
        vaultName: 'Current',
        manifestSequence: 8,
        lastSyncedAt: null,
        offlineAvailableAt: '2026-06-18T00:05:00Z',
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-18T00:00:00Z',
        capabilities: ['vault.read', 'vault.offlineCopy'],
      },
      {
        serverUrl: 'https://a.test',
        vaultId: 'manifest-only',
        vaultName: 'Manifest only',
        manifestSequence: 1,
        lastSyncedAt: null,
        offlineAvailableAt: null,
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-18T00:00:00Z',
        capabilities: ['vault.read', 'vault.offlineCopy'],
      },
    ]);

    await useSyncStore
      .getState()
      .refreshOfflineCopiesForServer('https://a.test', [
        hostedSummary('stale', 8),
        hostedSummary('current', 8),
        hostedSummary('manifest-only', 8),
      ]);

    expect(syncReplicaManifestDelta).toHaveBeenCalledTimes(1);
    expect(syncReplicaManifestDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        hostedVaultId: 'stale',
        capabilities: ['vault.read', 'vault.offlineCopy'],
      }),
      expect.any(Function),
    );
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it('does not refresh archived or unrelated-server offline copies', async () => {
    useVaultStore.setState({ vault: null } as never);
    vi.mocked(listHostedVaultReplicas).mockResolvedValue([
      {
        serverUrl: 'https://b.test',
        vaultId: 'archived',
        vaultName: 'Archived',
        manifestSequence: 1,
        lastSyncedAt: null,
        offlineAvailableAt: '2026-06-18T00:05:00Z',
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-18T00:00:00Z',
        capabilities: ['vault.read', 'vault.offlineCopy'],
      },
    ]);
    const archived = { ...hostedSummary('archived', 8), status: 'archived' as const };

    await useSyncStore.getState().refreshOfflineCopiesForServer('https://a.test', [archived]);

    expect(syncReplicaManifestDelta).not.toHaveBeenCalled();
  });

  it('syncNow runs a manifest delta sync then refreshes', async () => {
    await useSyncStore.getState().syncNow(vault);
    expect(syncReplicaManifestDelta).toHaveBeenCalledWith(vault, expect.any(Function));
    expect(tauriCommands.replicaReadSyncState).toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it('reports background upload progress through the shared transfer list', async () => {
    vi.mocked(syncReplicaManifestDelta).mockImplementationOnce(async (_vault, onProgress) => {
      onProgress?.({ direction: 'upload', completed: 1, total: 2, detail: 'Notes/Plan.md' });
      onProgress?.({ direction: 'upload', completed: 2, total: 2, detail: 'Pictures/chart.png' });
      return {} as never;
    });

    await useSyncStore.getState().syncNow(vault);

    expect(useSyncTransferStore.getState().transfers[0]).toMatchObject({
      direction: 'upload',
      completed: 2,
      total: 2,
      detail: 'Pictures/chart.png',
      status: 'completed',
    });
  });

  it('retry re-queues the operation and triggers a sync', async () => {
    await useSyncStore.getState().retry(vault, 'op-1');
    expect(retryPendingOperation).toHaveBeenCalledWith(vault, 'op-1');
    expect(syncReplicaManifestDelta).toHaveBeenCalledWith(vault, expect.any(Function));
  });

  it('discard removes the operation and refreshes', async () => {
    await useSyncStore.getState().discard(vault, 'op-1');
    expect(discardPendingOperation).toHaveBeenCalledWith(vault, 'op-1');
    expect(tauriCommands.replicaListPendingOperations).toHaveBeenCalled();
  });

  it('makeAvailableOffline caches hosted content and refreshes the sync snapshot', async () => {
    const progress = vi.fn();
    const report = await useSyncStore.getState().makeAvailableOffline(vault, progress);
    expect(makeHostedVaultAvailableOffline).toHaveBeenCalledWith(vault, expect.any(Function));
    expect(report).toEqual({ documentsCached: 1, assetsCached: 2, skipped: 0 });
    expect(tauriCommands.replicaReadSyncState).toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it('derives revoked access from a permission-denied replay failure', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      pending('c', 'failed'),
    ]);
    vi.mocked(listPendingOperationRecoveries).mockResolvedValue([
      {
        operation: pending('c', 'failed'),
        failure: { code: 'permission_revoked', message: 'forbidden' },
        recommendedAction: 'reconnect-account',
      },
    ]);
    await useSyncStore.getState().refresh(vault);
    expect(useSyncStore.getState().access).toBe('revoked');
  });

  it('classifies access loss on a syncNow network rejection with no pending ops', async () => {
    vi.mocked(syncReplicaManifestDelta).mockRejectedValueOnce(new Error('resource_not_found'));
    await useSyncStore.getState().syncNow(vault);
    expect(useSyncStore.getState().access).toBe('unavailable');
  });

  it('removeReplica deletes the local replica and clears state', async () => {
    useSyncStore.setState({ access: 'revoked', pending: [pending('a')] });
    await useSyncStore.getState().removeReplica(vault);
    expect(tauriCommands.replicaDelete).toHaveBeenCalledWith(vault.serverUrl, vault.hostedVaultId);
    expect(useSyncStore.getState().access).toBe('ok');
    expect(useSyncStore.getState().pending).toEqual([]);
  });
});
