import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toast } from 'sonner';

import { type BackgroundJobRecord, tauriCommands } from '../../../lib/tauri';
import { onReplicaMutated } from '../../../lib/vaultReplica';
import { useServerStore } from '../../../store/serverStore';
import { syncRollup, useSyncStore } from '../../../store/syncStore';
import { useSyncTransferStore } from '../../../store/syncTransferStore';
import { useVaultStore } from '../../../store/vaultStore';
import { type HostedVaultMeta, vaultKind } from '../../../types/vault';

const POLL_INTERVAL_MS = 5000;

/**
 * Offline-sync state of the open hosted vault, kept current through a replica
 * mutation subscription, a focused poll, the server connection status and
 * window focus/online events. Reconnecting to the vault's server replays and
 * pulls automatically. Inactive (and cleared) for local vaults.
 */
export function useVaultSync() {
  const vault = useVaultStore((state) => state.vault);
  const closeVault = useVaultStore((state) => state.closeVault);
  const serverStatus = useServerStore((state) =>
    vault?.kind === 'hosted' ? (state.connections[vault.serverUrl]?.status ?? null) : null,
  );
  const status = useSyncStore((state) => state.status);
  const lastSyncedAt = useSyncStore((state) => state.lastSyncedAt);
  const offlineAvailableAt = useSyncStore((state) => state.offlineAvailableAt);
  const pending = useSyncStore((state) => state.pending);
  const failed = useSyncStore((state) => state.failed);
  const access = useSyncStore((state) => state.access);
  const isSyncing = useSyncStore((state) => state.isSyncing);
  const refresh = useSyncStore((state) => state.refresh);
  const syncNowInStore = useSyncStore((state) => state.syncNow);
  const retryInStore = useSyncStore((state) => state.retry);
  const discardInStore = useSyncStore((state) => state.discard);
  const removeReplica = useSyncStore((state) => state.removeReplica);
  const clear = useSyncStore((state) => state.clear);
  const transfers = useSyncTransferStore((state) => state.transfers);
  const clearFinishedTransfers = useSyncTransferStore((state) => state.clearFinished);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobRecord[]>([]);
  const lastConflictCount = useRef(0);
  const wasOnlineRef = useRef<boolean | null>(null);

  const hostedVault = vault && vaultKind(vault) === 'hosted' ? (vault as HostedVaultMeta) : null;

  const doRefresh = useCallback(() => {
    if (hostedVault) void refresh(hostedVault);
  }, [hostedVault, refresh]);

  const refreshBackgroundJobs = useCallback(() => {
    if (!hostedVault || typeof tauriCommands.backgroundJobList !== 'function') {
      setBackgroundJobs([]);
      return;
    }
    void tauriCommands
      .backgroundJobList(30)
      .then((jobs) =>
        setBackgroundJobs(
          jobs
            .filter(
              (job) =>
                job.serverUrl === hostedVault.serverUrl &&
                (job.vaultId === null || job.vaultId === hostedVault.hostedVaultId),
            )
            .slice(0, 8),
        ),
      )
      .catch(() => {});
  }, [hostedVault]);

  useEffect(() => {
    if (!hostedVault) {
      clear();
      return;
    }
    doRefresh();
  }, [hostedVault, doRefresh, clear]);

  useEffect(() => {
    refreshBackgroundJobs();
    if (!hostedVault) return;
    const timer = window.setInterval(refreshBackgroundJobs, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hostedVault, refreshBackgroundJobs]);

  useEffect(() => {
    if (!hostedVault) return;
    return onReplicaMutated(doRefresh);
  }, [hostedVault, doRefresh]);

  const serverOnline =
    !!hostedVault &&
    serverStatus?.connected === true &&
    serverStatus.serverUrl === hostedVault.serverUrl;

  // Re-read on connection changes, and replay/pull once the vault's server is back.
  useEffect(() => {
    if (!hostedVault) {
      wasOnlineRef.current = null;
      return;
    }
    doRefresh();
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = serverOnline;
    if (wasOnline === false && serverOnline) {
      void syncNowInStore(hostedVault).catch(() => {});
    }
  }, [serverOnline, hostedVault, doRefresh, syncNowInStore]);

  useEffect(() => {
    if (!hostedVault) return;
    let timer: number | undefined;
    const startPolling = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') doRefresh();
      }, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onFocus = () => {
      doRefresh();
      startPolling();
    };
    startPolling();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', doRefresh);
    window.addEventListener('blur', stopPolling);
    return () => {
      stopPolling();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', doRefresh);
      window.removeEventListener('blur', stopPolling);
    };
  }, [hostedVault, doRefresh]);

  // Toast when a new conflict appears so it is noticed with the panel closed.
  useEffect(() => {
    if (failed.length > lastConflictCount.current) {
      toast.error(
        failed.length === 1
          ? 'A sync change could not be applied and needs your attention.'
          : `${failed.length} sync changes could not be applied and need your attention.`,
      );
    }
    lastConflictCount.current = failed.length;
  }, [failed.length]);

  // Transfers are app-wide: an offline copy can download from the start screen.
  const vaultTransfers = transfers;
  const activeTransfers = vaultTransfers.filter((transfer) => transfer.status === 'active');
  const recentTransfers = vaultTransfers
    .filter((transfer) => transfer.status !== 'active')
    .slice(0, 5);
  const activeBackgroundJobs = backgroundJobs.filter(
    (job) => job.status === 'queued' || job.status === 'running',
  );
  const rollup = useMemo(
    () =>
      syncRollup({
        isSyncing: isSyncing || activeTransfers.length > 0 || activeBackgroundJobs.length > 0,
        status,
        pending,
        failed,
      }),
    [isSyncing, status, pending, failed, activeTransfers.length, activeBackgroundJobs.length],
  );

  const syncNow = async () => {
    if (!hostedVault) return;
    try {
      await syncNowInStore(hostedVault);
      refreshBackgroundJobs();
    } catch (error) {
      toast.error(`Sync failed: ${error}`);
    }
  };

  const removeOfflineCopy = async () => {
    if (!hostedVault) return;
    try {
      await removeReplica(hostedVault);
      closeVault();
      toast.success('Removed the local copy of this vault.');
    } catch (error) {
      toast.error(`Could not remove the local copy: ${error}`);
    }
  };

  const recover = async (operationId: string, action: 'retry' | 'discard') => {
    if (!hostedVault) return;
    setBusyOp(operationId);
    try {
      if (action === 'retry') await retryInStore(hostedVault, operationId);
      else await discardInStore(hostedVault, operationId);
    } catch (error) {
      toast.error(`Could not ${action} change: ${error}`);
    } finally {
      setBusyOp(null);
    }
  };

  return {
    hostedVault,
    serverOnline,
    rollup,
    access,
    accessLost: !!hostedVault && access !== 'ok',
    lastSyncedAt,
    offlineAvailableAt,
    pending,
    failed,
    isSyncing,
    busyOp,
    activeTransfers,
    recentTransfers,
    backgroundJobs,
    activeBackgroundJobs,
    clearFinishedTransfers,
    syncNow,
    removeOfflineCopy,
    recover,
  };
}

export type VaultSyncModel = ReturnType<typeof useVaultSync>;
