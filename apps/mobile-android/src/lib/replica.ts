/**
 * Mobile offline-replica orchestration. Thin wrapper over the shared native
 * `replica_*` commands (the same store the desktop uses): seed a vault's manifest,
 * cache active document/asset bodies for offline reading, read the replica back
 * when the server is unreachable, report per-file cache status, and remove an
 * offline copy. Phase 3 is read-only — no pending-operation queueing yet.
 */
import type { HostedVault } from '../mobileTauri';
import {
  hostedAssetDataUrl,
  HostedFileEntry,
  hostedRequest,
  parseFileEntries,
  RawHostedManifest,
  replicaCacheAsset,
  replicaCachedContentStatus,
  replicaCacheDocument,
  replicaDelete,
  replicaReadManifest,
  replicaReadSyncState,
  replicaSeed,
  replicaWriteSyncState,
} from '../mobileTauri';

export type FileCacheState = 'cached' | 'stale' | 'uncached';

export interface OfflineProgress {
  completed: number;
  total: number;
}

export function replicaKey(serverUrl: string, vaultId: string): string {
  return `${serverUrl}::${vaultId}`;
}

function dataUrlBase64(dataUrl: string): string {
  const match = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Hosted asset response was not a base64 data URL.');
  return match[1];
}

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchManifest(serverUrl: string, vaultId: string): Promise<RawHostedManifest> {
  return hostedRequest<RawHostedManifest>(serverUrl, 'GET', `/api/v1/vaults/${vaultId}/manifest`);
}

async function cacheFileBody(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
): Promise<void> {
  if (file.kind === 'document') {
    const document = await hostedRequest<{ content: string }>(
      serverUrl,
      'GET',
      `/api/v1/vaults/${vaultId}/files/${file.id}`,
    );
    await replicaCacheDocument(serverUrl, vaultId, file.id, document.content);
    return;
  }

  if (file.kind === 'asset') {
    const dataUrl = await hostedAssetDataUrl(serverUrl, vaultId, file.id);
    await replicaCacheAsset(serverUrl, vaultId, file.id, dataUrlBase64(dataUrl));
  }
}

/**
 * Seeds the latest manifest and downloads missing/stale active document and
 * asset bodies into the native replica so the vault remains usable offline.
 */
export async function refreshVaultOfflineContents(
  serverUrl: string,
  vault: HostedVault,
  onProgress?: (progress: OfflineProgress) => void,
): Promise<void> {
  const rawManifest = await fetchManifest(serverUrl, vault.id);
  await replicaSeed(
    serverUrl,
    vault.id,
    vault.name,
    rawManifest,
    {
      manifestSequence: rawManifest.sequence,
      lastSyncedAt: nowIso(),
      offlineAvailableAt: null,
      status: 'idle',
    },
    vault.role,
    vault.capabilities,
  );

  const files = parseFileEntries(rawManifest.files);
  const cacheable = files.filter(
    (file) => file.state === 'active' && (file.kind === 'document' || file.kind === 'asset'),
  );
  let completed = 0;
  onProgress?.({ completed, total: cacheable.length });

  for (const file of cacheable) {
    try {
      const status = await replicaCachedContentStatus(
        serverUrl,
        vault.id,
        file.id,
        file.kind,
        file.contentHash,
      );
      if (status.present && status.matchesExpectedHash) {
        continue;
      }
      await cacheFileBody(serverUrl, vault.id, file);
    } catch {
      // Skip individual failures; the vault is still usable for what cached.
    } finally {
      completed += 1;
      onProgress?.({ completed, total: cacheable.length });
    }
  }

  const syncState = await replicaReadSyncState(serverUrl, vault.id);
  await replicaWriteSyncState(serverUrl, vault.id, {
    ...syncState,
    manifestSequence: rawManifest.sequence,
    lastSyncedAt: syncState.lastSyncedAt ?? nowIso(),
    offlineAvailableAt: nowIso(),
    status: 'idle',
  });
}

/**
 * Downloads the vault's active document and asset bodies into the native replica
 * so it can be opened and read while offline. This is also the same repair path
 * used later to keep an already-enabled offline copy current.
 */
export async function makeVaultAvailableOffline(
  serverUrl: string,
  vault: HostedVault,
  onProgress?: (progress: OfflineProgress) => void,
): Promise<void> {
  await refreshVaultOfflineContents(serverUrl, vault, onProgress);
}

/** Removes all app-local replica data (and the durable key) for a vault. */
export async function removeOfflineCopy(serverUrl: string, vaultId: string): Promise<void> {
  await replicaDelete(serverUrl, vaultId);
}

/** Reads active files from the local replica manifest, or null if not seeded. */
export async function readReplicaFiles(
  serverUrl: string,
  vaultId: string,
): Promise<HostedFileEntry[] | null> {
  const manifest = await replicaReadManifest(serverUrl, vaultId);
  if (!manifest) return null;
  return parseFileEntries(manifest.files).filter((file) => file.state === 'active');
}

/** Per-file cache state for the offline file-browser badges. */
export async function fileCacheState(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
): Promise<FileCacheState> {
  if (file.kind !== 'document' && file.kind !== 'asset') return 'uncached';
  const status = await replicaCachedContentStatus(
    serverUrl,
    vaultId,
    file.id,
    file.kind,
    file.contentHash,
  );
  if (!status.present) return 'uncached';
  return status.matchesExpectedHash ? 'cached' : 'stale';
}
