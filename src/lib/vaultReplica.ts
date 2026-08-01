/**
 * Typed mirror of the native hosted-vault replica store (Phase 6 offline-sync
 * foundation). The replica is a per-vault on-disk cache the native side manages;
 * these types match the camelCase shapes the Tauri commands round-trip, and the
 * helpers here seed a replica when a hosted vault is opened.
 *
 * The replica holds vault *content* only — never tokens.
 */

import { tauriCommands } from './tauri';
import { vaultCan, type HostedVaultMeta } from '../types/vault';
import type { LogicComponentDefinition } from '../types/logicDiagram';
import { parseSheetDocument, serializeSheetDocument } from './sheet/document';
import { mergeSheetDocuments } from './sheet/collaboration';

/**
 * Lightweight change notification for the replica's local state. The sync UI
 * subscribes broadly so it can refresh after queued edits/replay/manual sync,
 * while active documents subscribe only to manifest-affecting events for their
 * own path. Content-cache-only updates must not make an editor re-read itself.
 */
export type ReplicaMutationKind = 'manifest' | 'content' | 'pending' | 'sync' | 'replica';

export interface ReplicaMutationEvent {
  kind: ReplicaMutationKind;
  /** Stable file IDs affected when known. Omitted means broad/unknown scope. */
  fileIds?: string[];
  /** Vault-relative paths affected when known. Omitted means broad/unknown scope. */
  relativePaths?: string[];
}

type ReplicaMutationListener = (event: ReplicaMutationEvent) => void;
const replicaMutationListeners = new Set<ReplicaMutationListener>();

export function onReplicaMutated(
  listener: ReplicaMutationListener,
  options?: { kinds?: ReplicaMutationKind[] },
): () => void {
  const allowedKinds = options?.kinds ? new Set(options.kinds) : null;
  const wrapped: ReplicaMutationListener = (event) => {
    if (allowedKinds && !allowedKinds.has(event.kind)) return;
    listener(event);
  };
  replicaMutationListeners.add(wrapped);
  return () => {
    replicaMutationListeners.delete(wrapped);
  };
}

export function emitReplicaMutated(event: ReplicaMutationEvent = { kind: 'replica' }): void {
  for (const listener of replicaMutationListeners) {
    try {
      listener(event);
    } catch {
      // A listener failure must never break a replica mutation.
    }
  }
}

export function replicaMutationAffectsPath(event: ReplicaMutationEvent, relativePath: string): boolean {
  return !event.relativePaths || event.relativePaths.includes(relativePath);
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface ReplicaSyncProgress {
  direction: 'upload' | 'download' | 'sync';
  completed: number;
  total: number | null;
  detail?: string | null;
}

export interface ReplicaSyncState {
  /** The server manifest sequence the replica last observed. */
  manifestSequence: number;
  /** ISO-8601 timestamp of the last successful synchronization, if any. */
  lastSyncedAt: string | null;
  /** Set after active document/asset bodies have been cached locally. */
  offlineAvailableAt?: string | null;
  status: SyncStatus;
}

export type PendingOpKind =
  | 'create'
  | 'edit'
  | 'rename'
  | 'move'
  | 'trash'
  | 'restore'
  | 'delete'
  | 'assetUpload'
  | 'logicComponentSave'
  | 'logicComponentDelete';

export type PendingOpStatus = 'pending' | 'inflight' | 'failed';

export interface PendingOperation {
  id: string;
  kind: PendingOpKind;
  fileId: string | null;
  relativePath: string | null;
  payload: unknown;
  /** The manifest sequence the operation was authored against. */
  baseManifestSequence: number;
  createdAt: string;
  status: PendingOpStatus;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface Tombstone {
  fileId: string;
  relativePath: string;
  deletedAt: string;
}

export interface ReplicaIntegrityReport {
  ok: boolean;
  corruptFiles: string[];
}

export interface CacheCleanupReport {
  removedFiles: number;
  freedBytes: number;
  remainingBytes: number;
}

export interface CachedContentStatus {
  present: boolean;
  matchesExpectedHash: boolean;
  actualSha256: string | null;
  sizeBytes: number | null;
}

export interface OfflineAvailabilityReport {
  documentsCached: number;
  assetsCached: number;
  skipped: number;
  alreadyCached?: number;
}

export interface ReplicaSummary {
  serverUrl: string;
  vaultId: string;
  vaultName: string;
  manifestSequence: number;
  lastSyncedAt: string | null;
  /** Present only after all active file bodies have been cached for offline use. */
  offlineAvailableAt?: string | null;
  status: SyncStatus;
  pendingCount: number;
  updatedAt: string;
  role?: string | null;
  capabilities: string[];
}

/**
 * Default byte budget for a single vault's cached document/asset/CRDT content.
 * Cached content is re-fetchable from the server, so the cleanup pass evicts the
 * least-recently-used entries above this budget while never touching content
 * referenced by a pending (unsynced) operation.
 */
export const REPLICA_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * The server manifest shape persisted verbatim in the replica. Only the fields
 * the replica seeding relies on are typed; the full server payload (including
 * trashed-file metadata) is passed through unchanged.
 */
export interface ReplicaManifest {
  vaultId: string;
  sequence: number;
  files: ReplicaManifestFile[];
}

export interface ReplicaManifestFile {
  id: string;
  [key: string]: unknown;
}

function currentRevisionHash(file: ReplicaManifestFile): string | null {
  const revision = file.currentRevision;
  if (!revision || typeof revision !== 'object') return null;
  const contentHash = (revision as { contentHash?: unknown }).contentHash;
  return typeof contentHash === 'string' && contentHash ? contentHash : null;
}

export interface ReplicaManifestDelta {
  vaultId: string;
  baseSequence: number;
  sequence: number;
  changedFiles: ReplicaManifestFile[];
}

export interface QueuePendingOperationInput {
  kind: PendingOpKind;
  fileId: string | null;
  relativePath: string | null;
  payload: unknown;
  baseManifestSequence: number;
}

interface PendingCreatePayload {
  parentId: string | null;
  name: string;
  kind: 'document' | 'folder';
  documentType: 'note' | 'kanban' | 'canvas' | 'sheet' | null;
  content: string;
  tempFileId?: string;
}

interface PendingEditPayload {
  targetFileId: string;
  expectedRevisionSequence: number;
  content: string;
  baseContent?: string;
}

interface HostedPendingDocument {
  file: {
    currentRevision: { sequence: number } | null;
  };
  content: string;
}

function isRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('revision_conflict') || normalized.includes('revision has changed');
}

async function replaySheetEditAfterConflict(
  vault: HostedVaultMeta,
  operation: PendingOperation,
  payload: PendingEditPayload,
): Promise<boolean> {
  if (!operation.relativePath?.toLowerCase().endsWith('.sheet') || payload.baseContent === undefined) {
    return false;
  }
  const current = await tauriCommands.hostedVaultRequest<HostedPendingDocument>(
    vault.serverUrl,
    'GET',
    `/api/v1/vaults/${vault.hostedVaultId}/files/${payload.targetFileId}`,
  );
  if (current.content === payload.content) return true;

  const workbookName = operation.relativePath.split('/').pop()?.replace(/\.sheet$/i, '') ?? 'Workbook';
  const base = parseSheetDocument(payload.baseContent, workbookName);
  const local = parseSheetDocument(payload.content, workbookName);
  const remote = parseSheetDocument(current.content, workbookName);
  const merged = mergeSheetDocuments(base, local, remote);
  if (merged.conflicts.length > 0) {
    const targets = merged.conflicts.slice(0, 3).map((conflict) => conflict.path).join(', ');
    throw new Error(`REVISION_CONFLICT: overlapping sheet edits require recovery (${targets}).`);
  }

  await tauriCommands.hostedVaultRequest(
    vault.serverUrl,
    'POST',
    `/api/v1/vaults/${vault.hostedVaultId}/files/${payload.targetFileId}/revisions`,
    {
      expectedRevisionSequence: current.file.currentRevision?.sequence ?? 0,
      content: serializeSheetDocument(merged.document),
    },
  );
  return true;
}

interface PendingAssetUploadPayload {
  parentId: string | null;
  name: string;
  mediaType: string;
  expectedHash: string;
  assetCacheId: string;
}

interface PendingStructuralPayload {
  targetFileId: string;
  parentId?: string | null;
  [key: string]: unknown;
}

interface PendingLogicComponentSavePayload {
  component: LogicComponentDefinition;
}

interface PendingLogicComponentDeletePayload {
  componentId: string;
}

export function initialSyncState(manifestSequence: number): ReplicaSyncState {
  return { manifestSequence, lastSyncedAt: new Date().toISOString(), offlineAvailableAt: null, status: 'idle' };
}

export function offlineSyncState(manifestSequence: number): ReplicaSyncState {
  return { manifestSequence, lastSyncedAt: new Date().toISOString(), offlineAvailableAt: null, status: 'offline' };
}

export function isLikelyConnectivityError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes('offline') ||
    message.includes('connect to the collab server') ||
    message.includes('no saved server session') ||
    message.includes('no active hosted server session') ||
    // The native client is connected to a *different* server (or to none) than
    // the one this vault belongs to. For this vault that is indistinguishable
    // from being offline: reads must fall back to the local replica and writes
    // must queue as pending operations, so edits are never lost and sync
    // resumes once its own server is reconnected — rather than hard-failing.
    message.includes('different collab server') ||
    message.includes('before opening hosted vaults') ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('could not reach') ||
    message.includes('connection') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    // Rate limiting is a transient transport condition. Pending writes must
    // remain queued and batch sync must stop instead of classifying each item
    // as permanently rejected (which can amplify one 429 into many retries).
    message.includes('too many requests') ||
    message.includes('rate_limited') ||
    message.includes('rate limited') ||
    message.includes('slow down and try again')
  );
}

export type PendingOperationFailureCode =
  | 'manifest_conflict'
  | 'revision_conflict'
  | 'path_conflict'
  | 'permission_revoked'
  | 'vault_unavailable'
  | 'server_rejected';

export interface PendingOperationFailure {
  code: PendingOperationFailureCode;
  message: string;
}

export interface PendingOperationRecovery {
  operation: PendingOperation;
  failure: PendingOperationFailure;
  recommendedAction: 'retry-after-refresh' | 'restore-manually' | 'reconnect-account' | 'discard-or-contact-admin';
}

/**
 * Whether the connected user can still sync this hosted vault. `revoked` means
 * the user's access was removed; `unavailable` means the vault no longer exists
 * for them (deleted or archived) on the server. In either case the local replica
 * (and any unsynced changes) is retained until the user explicitly removes it —
 * access loss must never silently discard local data.
 */
export type VaultAccessState = 'ok' | 'revoked' | 'unavailable';

/**
 * Classify a server error encountered while syncing as a vault-access change, or
 * `null` when it is an ordinary (connectivity/validation/conflict) error. A
 * removed membership and a deleted vault both surface as `not_found`; archived
 * vaults reject mutations with `vault_archived` — all map to a non-`ok` state.
 */
export function classifyVaultAccessError(error: unknown): Exclude<VaultAccessState, 'ok'> | null {
  const lower = String(error instanceof Error ? error.message : error).toLowerCase();
  if (
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('vault_permission_denied')
  ) {
    return 'revoked';
  }
  if (
    lower.includes('not found') ||
    lower.includes('not_found') ||
    lower.includes('resource_not_found') ||
    lower.includes('archived') ||
    lower.includes('pending deletion') ||
    lower.includes('vault_archived') ||
    lower.includes('vault_unavailable')
  ) {
    return 'unavailable';
  }
  return null;
}

/**
 * Derive the vault-access state from recorded pending-operation failures (no
 * network call). Replay records `permission_revoked` / `vault_unavailable` codes
 * when the server rejects queued operations, so a reconnect that lost access is
 * reflected without an extra probe.
 */
export function deriveVaultAccess(recoveries: PendingOperationRecovery[]): VaultAccessState {
  if (recoveries.some((recovery) => recovery.failure.code === 'permission_revoked')) {
    return 'revoked';
  }
  if (recoveries.some((recovery) => recovery.failure.code === 'vault_unavailable')) {
    return 'unavailable';
  }
  return 'ok';
}

export function classifyPendingOperationFailure(error: unknown): PendingOperationFailure {
  const message = String(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();
  if (lower.includes('manifest has changed') || lower.includes('manifest_conflict')) {
    return { code: 'manifest_conflict', message };
  }
  if (lower.includes('document has changed') || lower.includes('revision_conflict')) {
    return { code: 'revision_conflict', message };
  }
  if (lower.includes('path_conflict') || lower.includes('already exists') || lower.includes('destination')) {
    return { code: 'path_conflict', message };
  }
  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('unauthorized')) {
    return { code: 'permission_revoked', message };
  }
  if (lower.includes('archived') || lower.includes('pending deletion') || lower.includes('not found')) {
    return { code: 'vault_unavailable', message };
  }
  return { code: 'server_rejected', message };
}

export async function readCachedReplicaManifest(vault: HostedVaultMeta): Promise<ReplicaManifest | null> {
  return tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId);
}

export async function listHostedVaultReplicas(): Promise<ReplicaSummary[]> {
  return tauriCommands.replicaList();
}

export async function deleteHostedVaultReplica(replica: Pick<ReplicaSummary, 'serverUrl' | 'vaultId'>): Promise<void> {
  await tauriCommands.replicaDelete(replica.serverUrl, replica.vaultId);
  emitReplicaMutated({ kind: 'replica' });
}

export async function writeOptimisticReplicaManifest(
  vault: HostedVaultMeta,
  manifest: ReplicaManifest,
): Promise<void> {
  await tauriCommands.replicaSeed(
    vault.serverUrl,
    vault.hostedVaultId,
    vault.name,
    manifest,
    offlineSyncState(manifest.sequence),
    vault.role,
    vault.capabilities ?? [],
  );
  emitReplicaMutated({
    kind: 'manifest',
    fileIds: manifest.files.map((file) => file.id),
    relativePaths: manifest.files
      .map((file) => typeof file.relativePath === 'string' ? file.relativePath : null)
      .filter((path): path is string => path !== null),
  });
}

export async function enqueuePendingOperation(
  vault: HostedVaultMeta,
  input: QueuePendingOperationInput,
): Promise<PendingOperation> {
  const operation: PendingOperation = {
    id: crypto.randomUUID(),
    kind: input.kind,
    fileId: input.fileId,
    relativePath: input.relativePath,
    payload: input.payload,
    baseManifestSequence: input.baseManifestSequence,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  await tauriCommands.replicaEnqueueOperation(vault.serverUrl, vault.hostedVaultId, operation);
  emitReplicaMutated({
    kind: 'pending',
    fileIds: operation.fileId ? [operation.fileId] : undefined,
    relativePaths: operation.relativePath ? [operation.relativePath] : undefined,
  });
  return operation;
}

export async function readCachedLogicComponents(vault: HostedVaultMeta): Promise<LogicComponentDefinition[]> {
  return tauriCommands.replicaReadLogicComponents(vault.serverUrl, vault.hostedVaultId);
}

export async function writeCachedLogicComponents(
  vault: HostedVaultMeta,
  components: LogicComponentDefinition[],
): Promise<void> {
  await tauriCommands.replicaWriteLogicComponents(vault.serverUrl, vault.hostedVaultId, components);
  emitReplicaMutated({ kind: 'content' });
}

export async function listPendingOperationRecoveries(
  vault: HostedVaultMeta,
): Promise<PendingOperationRecovery[]> {
  const operations = await tauriCommands.replicaListPendingOperations(vault.serverUrl, vault.hostedVaultId);
  return operations
    .filter((operation) => operation.status === 'failed')
    .map((operation) => {
      const fallback = classifyPendingOperationFailure(operation.failureMessage ?? operation.failureCode ?? 'Replay failed.');
      const failure = {
        code: (operation.failureCode as PendingOperationFailureCode | undefined) ?? fallback.code,
        message: operation.failureMessage ?? fallback.message,
      };
      return {
        operation,
        failure,
        recommendedAction: recoveryActionForFailure(failure.code),
      };
    });
}

export async function retryPendingOperation(vault: HostedVaultMeta, operationId: string): Promise<void> {
  await tauriCommands.replicaUpdateOperationStatus(vault.serverUrl, vault.hostedVaultId, operationId, 'pending');
  emitReplicaMutated({ kind: 'pending' });
}

export async function discardPendingOperation(vault: HostedVaultMeta, operationId: string): Promise<void> {
  await tauriCommands.replicaRemoveOperation(vault.serverUrl, vault.hostedVaultId, operationId);
  emitReplicaMutated({ kind: 'pending' });
}

function recoveryActionForFailure(
  code: PendingOperationFailureCode,
): PendingOperationRecovery['recommendedAction'] {
  switch (code) {
    case 'manifest_conflict':
    case 'revision_conflict':
    case 'path_conflict':
      return 'retry-after-refresh';
    case 'permission_revoked':
      return 'reconnect-account';
    case 'vault_unavailable':
      return 'restore-manually';
    case 'server_rejected':
    default:
      return 'discard-or-contact-admin';
  }
}

function replaceMappedIds<T extends { targetFileId?: string; parentId?: string | null }>(
  payload: T,
  idMap: Map<string, string>,
): T {
  return {
    ...payload,
    targetFileId: payload.targetFileId ? (idMap.get(payload.targetFileId) ?? payload.targetFileId) : payload.targetFileId,
    parentId: payload.parentId ? (idMap.get(payload.parentId) ?? payload.parentId) : payload.parentId,
  };
}

export async function replayPendingOperations(
  vault: HostedVaultMeta,
  onProgress?: (progress: ReplicaSyncProgress) => void,
): Promise<void> {
  const operations = await tauriCommands.replicaListPendingOperations(vault.serverUrl, vault.hostedVaultId);
  const replayableOperations = operations.filter((operation) => operation.status !== 'failed');
  if (replayableOperations.length === 0) return;
  const idMap = new Map<string, string>();
  let stoppedForFailure = false;
  for (const operation of replayableOperations) {
    if (operation.status === 'inflight') {
      await tauriCommands.replicaUpdateOperationStatus(vault.serverUrl, vault.hostedVaultId, operation.id, 'pending');
    }
  }
  for (const [operationIndex, operation] of replayableOperations.entries()) {
    onProgress?.({
      direction: 'upload',
      completed: operationIndex,
      total: replayableOperations.length,
      detail: operation.relativePath ?? operation.fileId ?? operation.kind,
    });
    await tauriCommands.replicaUpdateOperationStatus(vault.serverUrl, vault.hostedVaultId, operation.id, 'inflight');
    try {
      if (operation.kind === 'create') {
        const payload = operation.payload as PendingCreatePayload;
        const createPayload = {
          parentId: payload.parentId ? (idMap.get(payload.parentId) ?? payload.parentId) : null,
          name: payload.name,
          kind: payload.kind,
          documentType: payload.documentType,
          content: payload.content,
        };
        const created = await tauriCommands.hostedVaultRequest<{ id: string }>(
          vault.serverUrl,
          'POST',
          `/api/v1/vaults/${vault.hostedVaultId}/files`,
          createPayload,
        );
        if (operation.fileId) idMap.set(operation.fileId, created.id);
        if (payload.tempFileId) idMap.set(payload.tempFileId, created.id);
      } else if (operation.kind === 'edit') {
        const payload = replaceMappedIds(operation.payload as PendingEditPayload, idMap);
        try {
          await tauriCommands.hostedVaultRequest(
            vault.serverUrl,
            'POST',
            `/api/v1/vaults/${vault.hostedVaultId}/files/${payload.targetFileId}/revisions`,
            { expectedRevisionSequence: payload.expectedRevisionSequence, content: payload.content },
          );
        } catch (error) {
          if (!isRevisionConflict(error) || !await replaySheetEditAfterConflict(vault, operation, payload)) {
            throw error;
          }
        }
      } else if (operation.kind === 'assetUpload') {
        const payload = replaceMappedIds(operation.payload as PendingAssetUploadPayload, idMap);
        const contentBase64 = await tauriCommands.replicaReadCachedAsset(
          vault.serverUrl,
          vault.hostedVaultId,
          payload.assetCacheId,
        );
        if (contentBase64 === null) {
          throw new Error('Cached upload bytes are no longer available for this pending asset upload.');
        }
        await tauriCommands.hostedVaultRequest(
          vault.serverUrl,
          'POST',
          `/api/v1/vaults/${vault.hostedVaultId}/uploads`,
          {
            parentId: payload.parentId ?? null,
            name: payload.name,
            mediaType: payload.mediaType,
            contentBase64,
            expectedHash: payload.expectedHash,
          },
        );
      } else if (operation.kind === 'logicComponentSave') {
        const payload = operation.payload as PendingLogicComponentSavePayload;
        const saved = await tauriCommands.hostedVaultRequest<LogicComponentDefinition>(
          vault.serverUrl,
          'POST',
          `/api/v1/vaults/${vault.hostedVaultId}/logic-components`,
          payload.component,
        );
        const cached = await readCachedLogicComponents(vault);
        await writeCachedLogicComponents(vault, [
          ...cached.filter((component) => component.id !== saved.id && component.name.toLowerCase() !== saved.name.toLowerCase()),
          saved,
        ].sort((a, b) => a.name.localeCompare(b.name)));
      } else if (operation.kind === 'logicComponentDelete') {
        const payload = operation.payload as PendingLogicComponentDeletePayload;
        await tauriCommands.hostedVaultRequest(
          vault.serverUrl,
          'DELETE',
          `/api/v1/vaults/${vault.hostedVaultId}/logic-components/${encodeURIComponent(payload.componentId)}`,
        );
      } else {
        const payload = replaceMappedIds(operation.payload as PendingStructuralPayload, idMap);
        await tauriCommands.hostedVaultRequest(
          vault.serverUrl,
          'POST',
          `/api/v1/vaults/${vault.hostedVaultId}/operations`,
          payload,
        );
      }
      await tauriCommands.replicaRemoveOperation(vault.serverUrl, vault.hostedVaultId, operation.id);
      onProgress?.({
        direction: 'upload',
        completed: operationIndex + 1,
        total: replayableOperations.length,
        detail: operation.relativePath ?? operation.fileId ?? operation.kind,
      });
    } catch (error) {
      if (isLikelyConnectivityError(error)) {
        await tauriCommands.replicaUpdateOperationStatus(
          vault.serverUrl,
          vault.hostedVaultId,
          operation.id,
          'pending',
        );
        throw error;
      }
      const failure = classifyPendingOperationFailure(error);
      await tauriCommands.replicaRecordOperationFailure(
        vault.serverUrl,
        vault.hostedVaultId,
        operation.id,
        failure.code,
        failure.message,
      );
      stoppedForFailure = true;
      break;
    }
  }
  if (!stoppedForFailure) await seedReplicaFromManifest(vault);
  emitReplicaMutated({ kind: stoppedForFailure ? 'pending' : 'sync' });
}

/**
 * Seed (create or refresh) the local replica for a hosted vault from the current
 * server manifest. Best-effort: callers should not let a failure here block
 * opening the vault.
 */
/**
 * Run a bounded cache-cleanup pass over the vault's replica, keeping cached
 * document/asset/CRDT content within {@link REPLICA_CACHE_BUDGET_BYTES} and
 * dropping orphaned/stray entries. Content referenced by pending operations is
 * never evicted. Best-effort: a missing or unseeded replica is a no-op.
 */
export async function cleanupReplicaCache(
  vault: HostedVaultMeta,
  budgetBytes: number = REPLICA_CACHE_BUDGET_BYTES,
): Promise<CacheCleanupReport> {
  return tauriCommands.replicaCleanup(vault.serverUrl, vault.hostedVaultId, budgetBytes);
}

export async function seedReplicaFromManifest(vault: HostedVaultMeta): Promise<void> {
  const manifest = await tauriCommands.hostedVaultRequest<ReplicaManifest>(
    vault.serverUrl,
    'GET',
    `/api/v1/vaults/${vault.hostedVaultId}/manifest`,
  );
  await tauriCommands.replicaSeed(
    vault.serverUrl,
    vault.hostedVaultId,
    vault.name,
    manifest,
    initialSyncState(manifest.sequence),
    vault.role,
    vault.capabilities ?? [],
  );
  emitReplicaMutated({
    kind: 'manifest',
    fileIds: manifest.files.map((file) => file.id),
    relativePaths: manifest.files
      .map((file) => typeof file.relativePath === 'string' ? file.relativePath : null)
      .filter((path): path is string => path !== null),
  });
}

function dataUrlBase64(dataUrl: string): string {
  const match = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Hosted asset response was not a base64 data URL.');
  return match[1];
}

async function markOfflineAvailable(vault: HostedVaultMeta, manifestSequence: number): Promise<void> {
  const syncState = await tauriCommands.replicaReadSyncState(vault.serverUrl, vault.hostedVaultId);
  await tauriCommands.replicaWriteSyncState(vault.serverUrl, vault.hostedVaultId, {
    ...syncState,
    manifestSequence,
    lastSyncedAt: syncState.lastSyncedAt ?? new Date().toISOString(),
    offlineAvailableAt: new Date().toISOString(),
  });
}

async function cacheActiveFilesForOffline(
  vault: HostedVaultMeta,
  files: ReplicaManifestFile[],
  onProgress?: (completed: number, total: number, detail?: string | null) => void,
): Promise<OfflineAvailabilityReport> {
  const cacheableFiles = files.filter(
    (file) => file.state === 'active' && (file.kind === 'document' || file.kind === 'asset'),
  );
  let completed = 0;
  let documentsCached = 0;
  let assetsCached = 0;
  let skipped = 0;
  let alreadyCached = 0;
  onProgress?.(completed, cacheableFiles.length);

  for (const file of cacheableFiles) {
    const detail = typeof file.relativePath === 'string' ? file.relativePath : file.id;
    onProgress?.(completed, cacheableFiles.length, detail);
    try {
      const kind = file.kind;
      if (kind !== 'document' && kind !== 'asset') {
        skipped += 1;
        continue;
      }
      const expectedHash = currentRevisionHash(file);
      const status = await tauriCommands.replicaCachedContentStatus(
        vault.serverUrl,
        vault.hostedVaultId,
        file.id,
        kind,
        expectedHash,
      );
      if (status.present && status.matchesExpectedHash) {
        alreadyCached += 1;
        continue;
      }
      if (kind === 'document') {
        const document = await tauriCommands.hostedVaultRequest<{ content: string }>(
          vault.serverUrl,
          'GET',
          `/api/v1/vaults/${vault.hostedVaultId}/files/${file.id}`,
        );
        await tauriCommands.replicaCacheDocument(vault.serverUrl, vault.hostedVaultId, file.id, document.content);
        documentsCached += 1;
      } else if (kind === 'asset') {
        const dataUrl = await tauriCommands.hostedVaultAssetDataUrl(vault.serverUrl, vault.hostedVaultId, file.id);
        await tauriCommands.replicaCacheAsset(vault.serverUrl, vault.hostedVaultId, file.id, dataUrlBase64(dataUrl));
        assetsCached += 1;
      }
    } catch (error) {
      // Once transport connectivity or the server request budget is exhausted,
      // every remaining file would fail for the same reason. Stop immediately
      // instead of turning one 429/offline response into hundreds of requests.
      if (isLikelyConnectivityError(error)) throw error;
      skipped += 1;
    } finally {
      completed += 1;
      onProgress?.(completed, cacheableFiles.length, detail);
    }
  }

  return { documentsCached, assetsCached, skipped, alreadyCached };
}

/**
 * Downloads the active hosted-vault content into the native replica so the vault
 * can be opened and edited while the server is unreachable. Opening a hosted
 * vault already seeds metadata automatically; this helper is the explicit
 * "make available offline" path that also caches document and asset bodies.
 */
export async function makeHostedVaultAvailableOffline(
  vault: HostedVaultMeta,
  onProgress?: (completed: number, total: number) => void,
): Promise<OfflineAvailabilityReport> {
  if (!vaultCan(vault, 'vault.offlineCopy')) {
    throw new Error('You do not have permission to create an offline copy of this vault.');
  }
  await seedReplicaFromManifest(vault);
  const manifest = await tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId);
  if (!manifest) throw new Error('Replica manifest was not available after seeding.');

  const report = await cacheActiveFilesForOffline(
    vault,
    manifest.files,
    (completed, total) => onProgress?.(completed, total),
  );
  try {
    const components = await tauriCommands.hostedVaultRequest<LogicComponentDefinition[]>(
      vault.serverUrl,
      'GET',
      `/api/v1/vaults/${vault.hostedVaultId}/logic-components`,
    );
    if (Array.isArray(components)) await writeCachedLogicComponents(vault, components);
  } catch {
    // Component caching is best-effort; document and asset availability should
    // still complete when this optional library endpoint is unavailable.
  }
  await markOfflineAvailable(vault, manifest.sequence);
  await cleanupReplicaCache(vault);
  emitReplicaMutated({ kind: 'content' });
  return report;
}

export async function syncReplicaManifestDelta(
  vault: HostedVaultMeta,
  onProgress?: (progress: ReplicaSyncProgress) => void,
): Promise<ReplicaManifest> {
  if (
    typeof tauriCommands.backgroundJobRun !== 'function'
    || typeof tauriCommands.backgroundJobGet !== 'function'
  ) {
    return syncReplicaManifestDeltaWithAdapter(vault, onProgress);
  }
  onProgress?.({ direction: 'sync', completed: 0, total: null, detail: 'Checking pending changes' });
  const job = await tauriCommands.backgroundJobRun({
    idempotencyKey: `foreground:${vault.hostedVaultId}:${crypto.randomUUID()}`,
    kind: 'replica_sync',
    serverUrl: vault.serverUrl,
    vaultId: vault.hostedVaultId,
    trigger: 'foreground',
    runtimeBudgetSeconds: 120,
  });
  let current = job;
  while (current.status === 'queued' || current.status === 'running') {
    onProgress?.({
      direction: 'sync',
      completed: current.progress.completed,
      total: current.progress.total,
      detail: current.progress.detail,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    const next = await tauriCommands.backgroundJobGet(current.id);
    if (!next) throw new Error('The native background sync job was lost.');
    current = next;
  }
  if (current.status !== 'succeeded') {
    throw new Error(
      current.errorMessage
      ?? current.summary
      ?? `Background synchronization ended with status ${current.status}.`,
    );
  }
  const manifest = await tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId);
  if (!manifest) throw new Error('Replica manifest was not available after synchronization.');
  if (current.changed !== 0) {
    emitReplicaMutated({
      kind: 'sync',
      fileIds: manifest.files.map((file) => file.id),
      relativePaths: manifest.files
        .map((file) => typeof file.relativePath === 'string' ? file.relativePath : null)
        .filter((path): path is string => path !== null),
    });
  }
  return manifest;
}

async function syncReplicaManifestDeltaWithAdapter(
  vault: HostedVaultMeta,
  onProgress?: (progress: ReplicaSyncProgress) => void,
): Promise<ReplicaManifest> {
  onProgress?.({ direction: 'sync', completed: 0, total: null, detail: 'Checking pending changes' });
  await replayPendingOperations(vault, onProgress).catch((error) => {
    if (!isLikelyConnectivityError(error)) throw error;
  });
  const [cachedManifest, syncState] = await Promise.all([
    tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId),
    tauriCommands.replicaReadSyncState(vault.serverUrl, vault.hostedVaultId),
  ]);
  const shouldMaintainOfflineCache = !!syncState.offlineAvailableAt && vaultCan(vault, 'vault.offlineCopy');

  if (!cachedManifest || syncState.manifestSequence > cachedManifest.sequence) {
    await seedReplicaFromManifest(vault);
    const seeded = await tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId);
    if (!seeded) throw new Error('Replica manifest was not available after seeding.');
    if (shouldMaintainOfflineCache) {
      await cacheActiveFilesForOffline(vault, seeded.files, (completed, total, detail) => {
        onProgress?.({ direction: 'download', completed, total, detail });
      });
      await markOfflineAvailable(vault, seeded.sequence);
      await cleanupReplicaCache(vault);
    }
    return seeded;
  }

  const delta = await tauriCommands.hostedVaultRequest<ReplicaManifestDelta>(
    vault.serverUrl,
    'GET',
    `/api/v1/vaults/${vault.hostedVaultId}/manifest/delta?since=${encodeURIComponent(String(syncState.manifestSequence))}`,
  );
  if (delta.sequence < cachedManifest.sequence || delta.baseSequence !== syncState.manifestSequence) {
    await seedReplicaFromManifest(vault);
    const seeded = await tauriCommands.replicaReadManifest(vault.serverUrl, vault.hostedVaultId);
    if (!seeded) throw new Error('Replica manifest was not available after seeding.');
    if (shouldMaintainOfflineCache) {
      await cacheActiveFilesForOffline(vault, seeded.files, (completed, total, detail) => {
        onProgress?.({ direction: 'download', completed, total, detail });
      });
      await markOfflineAvailable(vault, seeded.sequence);
      await cleanupReplicaCache(vault);
    }
    return seeded;
  }

  if (delta.sequence === cachedManifest.sequence && delta.changedFiles.length === 0) {
    return cachedManifest;
  }

  const filesById = new Map(cachedManifest.files.map((file) => [file.id, file]));
  for (const file of delta.changedFiles) filesById.set(file.id, file);
  const nextManifest: ReplicaManifest = {
    ...cachedManifest,
    vaultId: delta.vaultId,
    sequence: delta.sequence,
    files: Array.from(filesById.values()),
  };
  await tauriCommands.replicaSeed(
    vault.serverUrl,
    vault.hostedVaultId,
    vault.name,
    nextManifest,
    initialSyncState(delta.sequence),
    vault.role,
    vault.capabilities ?? [],
  );
  if (shouldMaintainOfflineCache) {
    await cacheActiveFilesForOffline(vault, delta.changedFiles, (completed, total, detail) => {
      onProgress?.({ direction: 'download', completed, total, detail });
    });
    await markOfflineAvailable(vault, delta.sequence);
    await cleanupReplicaCache(vault);
  }
  emitReplicaMutated({
    kind: 'manifest',
    fileIds: delta.changedFiles.map((file) => file.id),
    relativePaths: delta.changedFiles
      .map((file) => typeof file.relativePath === 'string' ? file.relativePath : null)
      .filter((path): path is string => path !== null),
  });
  return nextManifest;
}
