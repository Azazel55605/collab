import { Check, ChevronRight, Cloud, CloudDownload, CloudOff, Library, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SyncActivityBanner } from '../components/SyncActivityBanner';
import {
  Banner,
  ConfirmSheet,
  EmptyState,
  ProgressBar,
  ReadOnlyBadge,
  RoleBadge,
  Spinner,
} from '../components/ui';
import { formatBytes, isReadOnlyRole } from '../lib/format';
import { replicaKey } from '../lib/replica';
import type { HostedVault, MemberRole, ReplicaSummary } from '../mobileTauri';
import { useMobileStore } from '../state/store';

function canOffline(vault: HostedVault): boolean {
  return vault.capabilities.includes('vault.offlineCopy');
}

interface VaultListItem {
  serverUrl: string;
  vault: HostedVault;
  replica: ReplicaSummary | null;
  offlineOnly: boolean;
}

interface VaultGroup {
  serverUrl: string;
  connected: boolean;
  busy: boolean;
  items: VaultListItem[];
}

function roleFromReplica(role: string | null): MemberRole {
  return role === 'admin' || role === 'editor' || role === 'viewer' ? role : 'viewer';
}

function vaultFromReplica(replica: ReplicaSummary): HostedVault {
  return {
    id: replica.vaultId,
    name: replica.vaultName,
    role: roleFromReplica(replica.role),
    status: 'offline',
    members: 0,
    storageBytes: 0,
    manifestSequence: replica.manifestSequence,
    updatedAt: replica.updatedAt,
    capabilities: replica.capabilities,
  };
}

function serverLabel(serverUrl: string): string {
  return serverUrl.replace(/^https?:\/\//, '');
}

export function VaultsScreen() {
  const statuses = useMobileStore((s) => s.statuses);
  const vaults = useMobileStore((s) => s.vaults);
  const vaultsBusy = useMobileStore((s) => s.vaultsBusy);
  const selected = useMobileStore((s) => s.selected);
  const replicas = useMobileStore((s) => s.replicas);
  const offlineBusy = useMobileStore((s) => s.offlineBusy);
  const offlineProgress = useMobileStore((s) => s.offlineProgress);
  const offlineError = useMobileStore((s) => s.offlineError);
  const backgroundStatus = useMobileStore((s) => s.backgroundStatus);
  const activeSheet = useMobileStore((s) => s.activeSheet);
  const loadVaults = useMobileStore((s) => s.loadVaults);
  const selectVault = useMobileStore((s) => s.selectVault);
  const makeOffline = useMobileStore((s) => s.makeOffline);
  const removeOffline = useMobileStore((s) => s.removeOffline);
  const openSheet = useMobileStore((s) => s.openSheet);
  const closeSheet = useMobileStore((s) => s.closeSheet);

  const [removeBusy, setRemoveBusy] = useState(false);

  const connectedServers = useMemo(
    () => Object.values(statuses).filter((status) => status.connected && status.serverUrl),
    [statuses],
  );
  const vaultGroups = useMemo<VaultGroup[]>(() => {
    const groups: VaultGroup[] = [];
    const usedReplicaKeys = new Set<string>();
    const replicaSummaries = Object.values(replicas);

    for (const status of connectedServers) {
      const serverUrl = status.serverUrl as string;
      const list = vaults[serverUrl] ?? [];
      const items: VaultListItem[] = list.map((vault) => {
        const key = replicaKey(serverUrl, vault.id);
        const replica = replicas[key] ?? null;
        if (replica) usedReplicaKeys.add(key);
        return { serverUrl, vault, replica, offlineOnly: false };
      });

      for (const replica of replicaSummaries) {
        const key = replicaKey(replica.serverUrl, replica.vaultId);
        if (replica.serverUrl !== serverUrl || usedReplicaKeys.has(key)) continue;
        usedReplicaKeys.add(key);
        items.push({
          serverUrl,
          vault: vaultFromReplica(replica),
          replica,
          offlineOnly: true,
        });
      }

      groups.push({
        serverUrl,
        connected: true,
        busy: !!vaultsBusy[serverUrl],
        items,
      });
    }

    const offlineGroups = new Map<string, VaultListItem[]>();
    for (const replica of replicaSummaries) {
      const key = replicaKey(replica.serverUrl, replica.vaultId);
      if (usedReplicaKeys.has(key)) continue;
      const serverUrl = replica.serverUrl;
      const items = offlineGroups.get(serverUrl) ?? [];
      items.push({
        serverUrl,
        vault: vaultFromReplica(replica),
        replica,
        offlineOnly: true,
      });
      offlineGroups.set(serverUrl, items);
    }

    for (const [serverUrl, items] of offlineGroups) {
      groups.push({ serverUrl, connected: false, busy: false, items });
    }

    return groups;
  }, [connectedServers, replicas, vaults, vaultsBusy]);

  const confirmRemove = activeSheet?.kind === 'removeOffline' ? activeSheet : null;

  async function handleRemove() {
    if (!confirmRemove) return;
    setRemoveBusy(true);
    try {
      await removeOffline(confirmRemove.serverUrl, confirmRemove.vault.id);
      closeSheet();
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <h1>Vaults</h1>
          <p>{vaultGroups.length > 0 ? 'Choose a vault to browse' : 'No connected servers'}</p>
        </div>
      </header>

      <SyncActivityBanner status={backgroundStatus} />

      {offlineError ? <Banner tone="error">{offlineError}</Banner> : null}

      {vaultGroups.length === 0 ? (
        <EmptyState
          icon={<Cloud size={28} aria-hidden />}
          title="Nothing to show"
          message="Connect to a hosted server on the Servers tab to see its vaults here."
        />
      ) : null}

      {vaultGroups.map((group) => {
        const { serverUrl, items, busy } = group;
        return (
          <section className="server-group" key={serverUrl}>
            <div className="server-group-header">
              <span className="server-group-name">{serverLabel(serverUrl)}</span>
              {group.connected ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => loadVaults(serverUrl)}
                  disabled={busy}
                >
                  {busy ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}
                  Refresh
                </button>
              ) : (
                <span className="server-group-status">
                  <CloudOff size={14} aria-hidden />
                  Offline copies
                </span>
              )}
            </div>

            {items.length === 0 && !busy ? (
              <Banner tone="info">No vaults are available to you on this server.</Banner>
            ) : null}

            <ul className="list">
              {items.map(({ vault, replica, offlineOnly }) => {
                const key = replicaKey(serverUrl, vault.id);
                const isOffline = !!replica;
                const isActive =
                  selected?.vault.id === vault.id && selected?.serverUrl === serverUrl;
                const busyOffline = offlineBusy[key];
                const progress = offlineProgress[key];
                return (
                  <li className="list-row vault-list-row" key={vault.id}>
                    <div className="vault-row-inner">
                      <button
                        type="button"
                        className={`row-main vault-row ${isActive ? 'active' : ''}`}
                        onClick={() => selectVault(serverUrl, vault)}
                      >
                        <div className="vault-icon">
                          <Library size={20} aria-hidden />
                        </div>
                        <div className="row-text">
                          <strong>{vault.name}</strong>
                          <span>
                            {offlineOnly
                              ? [
                                  'Offline copy',
                                  replica ? `${replica.pendingCount} pending` : null,
                                  replica ? `seq ${replica.manifestSequence}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : [
                                  `${formatBytes(vault.storageBytes)} · ${vault.members} member${
                                    vault.members === 1 ? '' : 's'
                                  }`,
                                  isOffline ? 'offline copy' : null,
                                  replica && replica.pendingCount > 0
                                    ? `${replica.pendingCount} pending`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                          </span>
                        </div>
                        <div className="vault-badges">
                          {isReadOnlyRole(vault.role) ? <ReadOnlyBadge /> : null}
                          <RoleBadge role={vault.role} />
                          <ChevronRight size={18} aria-hidden className="row-chevron" />
                        </div>
                      </button>

                      <div className="offline-control">
                        {busyOffline ? (
                          <div className="offline-progress">
                            <Spinner size={15} />
                            {progress ? (
                              <span>
                                {progress.completed}/{progress.total}
                              </span>
                            ) : null}
                          </div>
                        ) : isOffline ? (
                          <button
                            type="button"
                            className="offline-chip available"
                            onClick={() => openSheet({ kind: 'removeOffline', serverUrl, vault })}
                          >
                            <Check size={14} aria-hidden />
                            Offline
                          </button>
                        ) : !offlineOnly && canOffline(vault) ? (
                          <button
                            type="button"
                            className="offline-chip"
                            onClick={() => makeOffline(serverUrl, vault).catch(() => {})}
                          >
                            <CloudDownload size={14} aria-hidden />
                            Save offline
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {busyOffline && progress ? (
                      <ProgressBar completed={progress.completed} total={progress.total} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {confirmRemove ? (
        <ConfirmSheet
          title="Remove offline copy?"
          message={`This deletes the locally cached copy of "${confirmRemove.vault.name}" from this device. The vault stays on the server.`}
          confirmLabel="Remove"
          destructive
          busy={removeBusy}
          onConfirm={handleRemove}
          onCancel={closeSheet}
        />
      ) : null}
    </div>
  );
}
