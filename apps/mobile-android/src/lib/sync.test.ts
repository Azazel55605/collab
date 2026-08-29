import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedFileEntry, PendingOperation } from '../mobileTauri';

import {
  classifyPendingOperationFailure,
  enqueueNoteEdit,
  isLikelyConnectivityError,
  pendingEditsForFile,
  replayPendingOperations,
} from './sync';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const NOTE: HostedFileEntry = {
  id: 'doc-1',
  parentId: null,
  name: 'Plan.md',
  relativePath: 'Plan.md',
  kind: 'document',
  documentType: 'note',
  state: 'active',
  updatedAt: null,
  sizeBytes: 7,
  contentHash: 'old-hash',
  revisionSequence: 3,
};

function editOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: overrides.id ?? 'op-1',
    kind: 'edit',
    fileId: NOTE.id,
    relativePath: NOTE.relativePath,
    payload: { targetFileId: NOTE.id, expectedRevisionSequence: 3, content: '# Queued' },
    baseManifestSequence: 10,
    createdAt: '2026-07-10T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

describe('mobile offline sync', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('classifies connectivity vs real failures', () => {
    expect(isLikelyConnectivityError(new Error('Failed to fetch'))).toBe(true);
    expect(isLikelyConnectivityError(new Error('Connect to the Collab server first'))).toBe(true);
    expect(isLikelyConnectivityError(new Error('The document has changed'))).toBe(false);

    expect(classifyPendingOperationFailure(new Error('The document has changed')).code).toBe(
      'revision_conflict',
    );
    expect(classifyPendingOperationFailure(new Error('permission denied')).code).toBe(
      'permission_revoked',
    );
  });

  it('queues an offline edit, coalescing an earlier queued edit and caching content', async () => {
    const enqueued: PendingOperation[] = [];
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'replica_list_pending_operations') {
        return Promise.resolve([editOp({ id: 'stale' })]);
      }
      if (command === 'replica_remove_operation') return Promise.resolve(null);
      if (command === 'replica_enqueue_operation') {
        enqueued.push(args.operation as PendingOperation);
        return Promise.resolve(null);
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const operation = await enqueueNoteEdit(SERVER, VAULT, NOTE, '# Newer', 10);

    // The earlier queued edit for this file is dropped before enqueuing the new one.
    expect(invoke).toHaveBeenCalledWith(
      'replica_remove_operation',
      expect.objectContaining({ operationId: 'stale' }),
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe('edit');
    expect(enqueued[0].payload).toMatchObject({ expectedRevisionSequence: 3, content: '# Newer' });
    // Edited content is cached so it survives an app restart.
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'doc-1', content: '# Newer' }),
    );
    expect(operation.status).toBe('pending');
  });

  it('replays a queued edit as a hosted revision and removes it on success', async () => {
    const statuses: Array<{ operationId: string; status: string }> = [];
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'replica_list_pending_operations') return Promise.resolve([editOp()]);
      if (command === 'replica_update_operation_status') {
        statuses.push({ operationId: args.operationId as string, status: args.status as string });
        return Promise.resolve(null);
      }
      if (command === 'hosted_vault_request') {
        expect(args.path).toBe(`/api/v1/vaults/${VAULT}/files/doc-1/revisions`);
        expect(args.body).toEqual({ expectedRevisionSequence: 3, content: '# Queued' });
        return Promise.resolve({ file: { ...NOTE, id: 'doc-1' }, content: '# Queued' });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      if (command === 'replica_remove_operation') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const result = await replayPendingOperations(SERVER, VAULT);

    expect(result).toMatchObject({
      replayed: 1,
      stoppedForConnectivity: false,
      stoppedForFailure: false,
    });
    expect(statuses).toContainEqual({ operationId: 'op-1', status: 'inflight' });
    expect(invoke).toHaveBeenCalledWith(
      'replica_remove_operation',
      expect.objectContaining({ operationId: 'op-1' }),
    );
  });

  it('records a recoverable failure when the server rejects a replayed edit', async () => {
    const failures: Array<Record<string, unknown>> = [];
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'replica_list_pending_operations') return Promise.resolve([editOp()]);
      if (command === 'replica_update_operation_status') return Promise.resolve(null);
      if (command === 'hosted_vault_request') {
        return Promise.reject(
          new Error('The document has changed on the server (revision_conflict).'),
        );
      }
      if (command === 'replica_record_operation_failure') {
        failures.push(args);
        return Promise.resolve(null);
      }
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const result = await replayPendingOperations(SERVER, VAULT);

    expect(result.stoppedForFailure).toBe(true);
    expect(result.replayed).toBe(0);
    expect(failures[0]).toMatchObject({ operationId: 'op-1', failureCode: 'revision_conflict' });
    // A rejected op is NOT removed — it stays for retry/discard recovery.
    expect(invoke).not.toHaveBeenCalledWith('replica_remove_operation', expect.anything());
  });

  it('keeps an operation queued when the server is unreachable', async () => {
    const statuses: string[] = [];
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'replica_list_pending_operations') return Promise.resolve([editOp()]);
      if (command === 'replica_update_operation_status') {
        statuses.push(args.status as string);
        return Promise.resolve(null);
      }
      if (command === 'hosted_vault_request') return Promise.reject(new Error('Failed to fetch'));
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const result = await replayPendingOperations(SERVER, VAULT);

    expect(result.stoppedForConnectivity).toBe(true);
    // Reset back to pending, never recorded as a failure.
    expect(statuses).toEqual(['inflight', 'pending']);
    expect(invoke).not.toHaveBeenCalledWith('replica_record_operation_failure', expect.anything());
  });

  it('lists only queued edits for a given file', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_list_pending_operations') {
        return Promise.resolve([editOp({ id: 'op-a' }), editOp({ id: 'op-b', fileId: 'other' })]);
      }
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const edits = await pendingEditsForFile(SERVER, VAULT, 'doc-1');
    expect(edits.map((operation) => operation.id)).toEqual(['op-a']);
  });
});
