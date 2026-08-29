import { create } from 'zustand';

import { tauriCommands } from '../lib/tauri';
import {
  classifyVaultAccessError,
  deriveVaultAccess,
  discardPendingOperation,
  isLikelyConnectivityError,
  listHostedVaultReplicas,
  listPendingOperationRecoveries,
  makeHostedVaultAvailableOffline,
  type OfflineAvailabilityReport,
  type PendingOperation,
  type PendingOperationRecovery,
  type ReplicaSummary,
  type ReplicaSyncProgress,
  retryPendingOperation,
  syncReplicaManifestDelta,
  type SyncStatus,
  type VaultAccessState,
} from '../lib/vaultReplica';
import { hostedVaultMeta, type HostedVaultMeta, type HostedVaultSummary } from '../types/vault';
import type { MemberRole } from '../types/vault';

import { useSyncTransferStore } from './syncTransferStore';
import { useVaultStore } from './vaultStore';

/** The coarse rollup the status-bar indicator renders. */
export type SyncRollup = 'synced' | 'syncing' | 'pending' | 'conflicts';

interface SyncStoreState {
  /** `serverUrl|vaultId` the current snapshot belongs to, or null when not hosted. */
  vaultKey: string | null;
  /** Replica sync-state status from the last refresh. */
  status: SyncStatus;
  lastSyncedAt: string | null;
  offlineAvailableAt: string | null;
  /** Queued operations not yet confirmed by the server (pending + inflight). */
  pending: PendingOperation[];
  /** Operations whose replay failed and need user recovery. */
  failed: PendingOperationRecovery[];
  /** Whether the connected user can still sync this vault. */
  access: VaultAccessState;
  /** True while a manual `syncNow` is running. */
  isSyncing: boolean;

  refresh: (vault: HostedVaultMeta) => Promise<void>;
  syncNow: (vault: HostedVaultMeta) => Promise<void>;
  retry: (vault: HostedVaultMeta, operationId: string) => Promise<void>;
  discard: (vault: HostedVaultMeta, operationId: string) => Promise<void>;
  makeAvailableOffline: (
    vault: HostedVaultMeta,
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<OfflineAvailabilityReport>;
  /** Permanently remove the local replica (used after access is lost). */
  removeReplica: (vault: HostedVaultMeta) => Promise<void>;
  /**
   * Replay + pull every local replica belonging to `serverUrl`. Used when a
   * server connection is (re)established so background offline edits across all
   * of that server's vaults — not just the open one — are pushed automatically.
   */
  syncAllForServer: (serverUrl: string) => Promise<void>;
  /** Pull server changes into stale full offline copies for one connected server. */
  refreshOfflineCopiesForServer: (serverUrl: string, vaults: HostedVaultSummary[]) => Promise<void>;
  clear: () => void;
}

function vaultKeyFor(vault: HostedVaultMeta): string {
  return `${vault.serverUrl}|${vault.hostedVaultId}`;
}

function beginSyncTransfer(vault: HostedVaultMeta, label = `Syncing ${vault.name}`): string {
  return useSyncTransferStore.getState().begin({
    vaultId: vault.hostedVaultId,
    vaultName: vault.name,
    direction: 'sync',
    label,
  });
}

function reportSyncTransfer(id: string, progress: ReplicaSyncProgress): void {
  const action =
    progress.direction === 'upload'
      ? 'Uploading changes'
      : progress.direction === 'download'
        ? 'Downloading changes'
        : 'Checking for changes';
  useSyncTransferStore.getState().update(id, {
    direction: progress.direction,
    label: action,
    detail: progress.detail ?? null,
    completed: progress.completed,
    total: progress.total,
  });
}

/**
 * Build a minimal hosted vault descriptor from a local replica summary so a
 * background (not currently open) vault can be synced without its full DTO.
 */
function vaultMetaFromReplica(summary: ReplicaSummary): HostedVaultMeta {
  return {
    kind: 'hosted',
    id: `hosted:${summary.serverUrl}:${summary.vaultId}`,
    name: summary.vaultName,
    path: `hosted://${summary.vaultId}`,
    lastOpened: 0,
    isEncrypted: false,
    serverUrl: summary.serverUrl,
    hostedVaultId: summary.vaultId,
    role: (summary.role as MemberRole | null) ?? 'editor',
    capabilities: summary.capabilities,
  };
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  vaultKey: null,
  status: 'idle',
  lastSyncedAt: null,
  offlineAvailableAt: null,
  pending: [],
  failed: [],
  access: 'ok',
  isSyncing: false,

  refresh: async (vault) => {
    const key = vaultKeyFor(vault);
    try {
      const [syncState, operations, recoveries] = await Promise.all([
        tauriCommands.replicaReadSyncState(vault.serverUrl, vault.hostedVaultId),
        tauriCommands.replicaListPendingOperations(vault.serverUrl, vault.hostedVaultId),
        listPendingOperationRecoveries(vault),
      ]);
      set({
        vaultKey: key,
        status: syncState.status,
        lastSyncedAt: syncState.lastSyncedAt,
        offlineAvailableAt: syncState.offlineAvailableAt ?? null,
        pending: operations.filter((operation) => operation.status !== 'failed'),
        failed: recoveries,
        // Reflect access loss already recorded by a failed replay. A clean queue
        // resets access to ok (e.g. after the user removes the failed ops).
        access: deriveVaultAccess(recoveries),
      });
    } catch {
      // A read failure (e.g. no replica yet) leaves a clean snapshot for the key.
      set({
        vaultKey: key,
        status: 'idle',
        lastSyncedAt: null,
        offlineAvailableAt: null,
        pending: [],
        failed: [],
        access: 'ok',
      });
    }
  },

  syncNow: async (vault) => {
    if (get().isSyncing) return;
    const transferId = beginSyncTransfer(vault);
    set({ isSyncing: true });
    try {
      // `syncReplicaManifestDelta` replays the pending queue first, then pulls
      // the manifest delta. It emits replica-mutation events that drive a
      // refresh, but refresh once more so the snapshot is current on return.
      await syncReplicaManifestDelta(vault, (progress) => reportSyncTransfer(transferId, progress));
      await get().refresh(vault);
      useSyncTransferStore.getState().complete(transferId, 'Sync complete');
    } catch (error) {
      useSyncTransferStore.getState().fail(transferId, error);
      // Refresh so the queue/failed list is current, then classify access loss
      // (covers the no-pending case where `refresh` can't derive it). A plain
      // connectivity error is left to the connection indicator; anything else is
      // rethrown so the caller can surface it.
      await get().refresh(vault);
      const access = classifyVaultAccessError(error);
      if (access) {
        set({ access });
      } else if (!isLikelyConnectivityError(error)) {
        throw error;
      }
    } finally {
      set({ isSyncing: false });
    }
  },

  retry: async (vault, operationId) => {
    await retryPendingOperation(vault, operationId);
    await get().syncNow(vault);
  },

  discard: async (vault, operationId) => {
    await discardPendingOperation(vault, operationId);
    await get().refresh(vault);
  },

  makeAvailableOffline: async (vault, onProgress) => {
    if (get().isSyncing) throw new Error('A sync is already running.');
    const transferId = beginSyncTransfer(vault, `Downloading ${vault.name}`);
    useSyncTransferStore.getState().update(transferId, { direction: 'download' });
    set({ isSyncing: true });
    try {
      const report = await makeHostedVaultAvailableOffline(vault, (completed, total) => {
        onProgress?.(completed, total);
        useSyncTransferStore.getState().update(transferId, { completed, total });
      });
      await get().refresh(vault);
      useSyncTransferStore.getState().complete(transferId, 'Offline copy downloaded');
      return report;
    } catch (error) {
      useSyncTransferStore.getState().fail(transferId, error);
      throw error;
    } finally {
      set({ isSyncing: false });
    }
  },

  removeReplica: async (vault) => {
    await tauriCommands.replicaDelete(vault.serverUrl, vault.hostedVaultId);
    get().clear();
  },

  syncAllForServer: async (serverUrl) => {
    if (get().isSyncing) return;
    let replicas: ReplicaSummary[];
    try {
      replicas = await listHostedVaultReplicas();
    } catch {
      return;
    }
    const targets = replicas.filter((replica) => replica.serverUrl === serverUrl);
    if (targets.length === 0) return;

    const openVault = useVaultStore.getState().vault;
    const openHosted = openVault && openVault.kind === 'hosted' ? openVault : null;

    set({ isSyncing: true });
    try {
      for (const replica of targets) {
        // Prefer the open vault's richer DTO (accurate capabilities) when it is
        // one of the targets; otherwise reconstruct a minimal descriptor.
        const vault =
          openHosted &&
          openHosted.serverUrl === replica.serverUrl &&
          openHosted.hostedVaultId === replica.vaultId
            ? openHosted
            : vaultMetaFromReplica(replica);
        const transferId = beginSyncTransfer(vault);
        try {
          await syncReplicaManifestDelta(vault, (progress) =>
            reportSyncTransfer(transferId, progress),
          );
          useSyncTransferStore.getState().complete(transferId, 'Background sync complete');
        } catch (error) {
          useSyncTransferStore.getState().fail(transferId, error);
          // Best-effort: a still-offline vault, a conflict, or lost access is
          // recorded in that replica's own queue and surfaced when it is opened.
        }
      }
    } finally {
      set({ isSyncing: false });
      // Refresh the open vault's snapshot so the indicator reflects the sync.
      if (openHosted) await get().refresh(openHosted);
    }
  },

  refreshOfflineCopiesForServer: async (serverUrl, vaults) => {
    if (get().isSyncing) return;
    let replicas: ReplicaSummary[];
    try {
      replicas = await listHostedVaultReplicas();
    } catch {
      return;
    }

    const serverVaults = new Map(
      vaults.filter((vault) => vault.status === 'active').map((vault) => [vault.id, vault]),
    );
    const targets = replicas.filter((replica) => {
      const remote = serverVaults.get(replica.vaultId);
      return (
        replica.serverUrl === serverUrl &&
        !!replica.offlineAvailableAt &&
        !!remote &&
        remote.manifestSequence > replica.manifestSequence
      );
    });
    if (targets.length === 0) return;

    const openVault = useVaultStore.getState().vault;
    const openHosted = openVault && openVault.kind === 'hosted' ? openVault : null;
    set({ isSyncing: true });
    try {
      for (const replica of targets) {
        const remote = serverVaults.get(replica.vaultId);
        if (!remote) continue;
        const remoteVault = hostedVaultMeta(serverUrl, remote);
        const transferId = beginSyncTransfer(remoteVault, `Updating offline copy · ${remote.name}`);
        try {
          // Use the latest server DTO so role and capability changes are applied
          // before deciding whether cached file bodies may be refreshed.
          await syncReplicaManifestDelta(remoteVault, (progress) =>
            reportSyncTransfer(transferId, progress),
          );
          useSyncTransferStore.getState().complete(transferId, 'Offline copy updated');
        } catch (error) {
          useSyncTransferStore.getState().fail(transferId, error);
          // Best-effort background pull. The next inventory heartbeat retries a
          // still-stale copy without interrupting the user's current work.
        }
      }
    } finally {
      set({ isSyncing: false });
      if (openHosted && openHosted.serverUrl === serverUrl) {
        await get().refresh(openHosted);
      }
    }
  },

  clear: () =>
    set({
      vaultKey: null,
      status: 'idle',
      lastSyncedAt: null,
      offlineAvailableAt: null,
      pending: [],
      failed: [],
      access: 'ok',
      isSyncing: false,
    }),
}));

/** Derives the coarse rollup from a snapshot for the status-bar indicator. */
export function syncRollup(
  state: Pick<SyncStoreState, 'isSyncing' | 'status' | 'pending' | 'failed'>,
): SyncRollup {
  if (state.failed.length > 0) return 'conflicts';
  if (state.isSyncing || state.status === 'syncing') return 'syncing';
  if (state.pending.length > 0) return 'pending';
  return 'synced';
}
