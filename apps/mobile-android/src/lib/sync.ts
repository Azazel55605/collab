/**
 * Mobile offline write queue + sync replay (Phase 4, notes MVP slice).
 *
 * Note edits made while the server is unreachable are cached in the native
 * replica (so they survive an app restart) and appended to the replica's
 * pending-operation queue. When the vault's server reconnects the queue is
 * replayed as hosted document-revision writes. This mirrors the desktop replica
 * pending-operation model so both clients replay through the same native store;
 * only the `edit` operation kind is produced on mobile so far.
 */
import {
  HostedFileEntry,
  PendingOperation,
  replicaCacheDocument,
  replicaEnqueueOperation,
  replicaListPendingOperations,
  replicaRecordOperationFailure,
  replicaRemoveOperation,
  replicaUpdateOperationStatus,
  writeHostedDocument,
} from '../mobileTauri';

interface PendingEditPayload {
  targetFileId: string;
  expectedRevisionSequence: number;
  content: string;
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

/**
 * Whether an error means "the server is unreachable right now" rather than a
 * genuine rejection. Connectivity errors leave the operation queued for a later
 * replay; anything else is recorded as a recoverable failure.
 */
export function isLikelyConnectivityError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes('offline') ||
    message.includes('connect to the collab server') ||
    message.includes('no saved server session') ||
    message.includes('no active hosted server session') ||
    message.includes('different collab server') ||
    message.includes('before opening hosted vaults') ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('could not reach') ||
    message.includes('connection') ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
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
  if (
    lower.includes('path_conflict') ||
    lower.includes('already exists') ||
    lower.includes('destination')
  ) {
    return { code: 'path_conflict', message };
  }
  if (
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized')
  ) {
    return { code: 'permission_revoked', message };
  }
  if (
    lower.includes('archived') ||
    lower.includes('pending deletion') ||
    lower.includes('not found')
  ) {
    return { code: 'vault_unavailable', message };
  }
  return { code: 'server_rejected', message };
}

/** Human-readable summary for a failed pending operation. */
export function describePendingFailure(operation: PendingOperation): string {
  if (operation.failureMessage) return operation.failureMessage;
  switch (operation.failureCode) {
    case 'revision_conflict':
    case 'manifest_conflict':
      return 'This note changed on the server since your offline edit.';
    case 'permission_revoked':
      return 'Your access to this vault changed. Reconnect your account.';
    case 'vault_unavailable':
      return 'This vault is no longer available on the server.';
    default:
      return 'The server rejected this change.';
  }
}

/** Non-failed pending edit operations queued for a given file. */
export async function pendingEditsForFile(
  serverUrl: string,
  vaultId: string,
  fileId: string,
): Promise<PendingOperation[]> {
  const operations = await replicaListPendingOperations(serverUrl, vaultId);
  return operations.filter((operation) => operation.kind === 'edit' && operation.fileId === fileId);
}

/**
 * Queue an offline edit for a text-backed document (a note or a `.kanban` /
 * `.canvas` JSON document — the replay path is content-agnostic). Any earlier
 * queued edit for the same file is coalesced away (dropped) so only the latest
 * content is replayed — this avoids a chain of offline edits self-conflicting on
 * their revision sequences. The edited content is written into the replica
 * document cache so it is visible when the document is reopened, even after an
 * app restart.
 */
export async function enqueueDocumentEdit(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  content: string,
  baseManifestSequence: number,
): Promise<PendingOperation> {
  const existing = await replicaListPendingOperations(serverUrl, vaultId);
  for (const operation of existing) {
    if (operation.kind === 'edit' && operation.fileId === file.id) {
      await replicaRemoveOperation(serverUrl, vaultId, operation.id).catch(() => {});
    }
  }

  const payload: PendingEditPayload = {
    targetFileId: file.id,
    expectedRevisionSequence: file.revisionSequence ?? 0,
    content,
  };
  const operation: PendingOperation = {
    id: crypto.randomUUID(),
    kind: 'edit',
    fileId: file.id,
    relativePath: file.relativePath,
    payload,
    baseManifestSequence,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  await replicaEnqueueOperation(serverUrl, vaultId, operation);
  await replicaCacheDocument(serverUrl, vaultId, file.id, content).catch(() => {});
  return operation;
}

/**
 * Back-compat alias for {@link enqueueDocumentEdit}. The queue is content
 * agnostic, so notes and Kanban boards enqueue through the same path.
 */
export const enqueueNoteEdit = enqueueDocumentEdit;

/** Re-queue a failed operation for another replay attempt. */
export async function retryPendingOperation(
  serverUrl: string,
  vaultId: string,
  operationId: string,
): Promise<void> {
  await replicaUpdateOperationStatus(serverUrl, vaultId, operationId, 'pending');
}

/** Drop a queued (or failed) operation from the replica queue. */
export async function discardPendingOperation(
  serverUrl: string,
  vaultId: string,
  operationId: string,
): Promise<void> {
  await replicaRemoveOperation(serverUrl, vaultId, operationId);
}

export interface ReplayResult {
  replayed: number;
  /** Set when replay stopped early because the server is still unreachable. */
  stoppedForConnectivity: boolean;
  /** Set when replay stopped because an operation was rejected by the server. */
  stoppedForFailure: boolean;
}

/**
 * Replay the vault's queued (non-failed) operations against its server. Stops
 * and leaves the operation queued if the server is unreachable, or records a
 * recoverable failure and stops if the server rejects an operation. Successful
 * operations are removed from the queue.
 */
export async function replayPendingOperations(
  serverUrl: string,
  vaultId: string,
): Promise<ReplayResult> {
  const operations = await replicaListPendingOperations(serverUrl, vaultId);
  const replayable = operations.filter((operation) => operation.status !== 'failed');
  const result: ReplayResult = {
    replayed: 0,
    stoppedForConnectivity: false,
    stoppedForFailure: false,
  };
  if (replayable.length === 0) return result;

  // Reset any operation left mid-flight by a previous interrupted replay.
  for (const operation of replayable) {
    if (operation.status === 'inflight') {
      await replicaUpdateOperationStatus(serverUrl, vaultId, operation.id, 'pending');
    }
  }

  for (const operation of replayable) {
    await replicaUpdateOperationStatus(serverUrl, vaultId, operation.id, 'inflight');
    try {
      if (operation.kind === 'edit') {
        const payload = operation.payload as PendingEditPayload;
        await writeHostedDocument(
          serverUrl,
          vaultId,
          payload.targetFileId,
          payload.expectedRevisionSequence,
          payload.content,
        );
      } else {
        // The mobile notes MVP only queues edits; a future slice adds the rest.
        throw new Error(`Unsupported offline operation: ${operation.kind}`);
      }
      await replicaRemoveOperation(serverUrl, vaultId, operation.id);
      result.replayed += 1;
    } catch (error) {
      if (isLikelyConnectivityError(error)) {
        await replicaUpdateOperationStatus(serverUrl, vaultId, operation.id, 'pending');
        result.stoppedForConnectivity = true;
        return result;
      }
      const failure = classifyPendingOperationFailure(error);
      await replicaRecordOperationFailure(
        serverUrl,
        vaultId,
        operation.id,
        failure.code,
        failure.message,
      );
      result.stoppedForFailure = true;
      return result;
    }
  }
  return result;
}
