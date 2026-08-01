import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedVaultMeta } from '../types/vault';
import { tauriCommands } from './tauri';
import { createWorkbookFixture } from './sheet/fixture';
import { serializeSheetDocument } from './sheet/document';
import { sheetCellKey } from '../types/sheet';
import {
  classifyPendingOperationFailure,
  cleanupReplicaCache,
  discardPendingOperation,
  enqueuePendingOperation,
  emitReplicaMutated,
  initialSyncState,
  isLikelyConnectivityError,
  listPendingOperationRecoveries,
  makeHostedVaultAvailableOffline,
  onReplicaMutated,
  replayPendingOperations,
  REPLICA_CACHE_BUDGET_BYTES,
  replicaMutationAffectsPath,
  retryPendingOperation,
  seedReplicaFromManifest,
  syncReplicaManifestDelta,
} from './vaultReplica';

vi.mock('./tauri', () => ({
  tauriCommands: {
    hostedVaultRequest: vi.fn(),
    replicaSeed: vi.fn().mockResolvedValue(undefined),
    replicaList: vi.fn().mockResolvedValue([]),
    replicaReadManifest: vi.fn(),
    replicaReadSyncState: vi.fn(),
    replicaWriteSyncState: vi.fn().mockResolvedValue(undefined),
    replicaEnqueueOperation: vi.fn().mockResolvedValue(undefined),
    replicaListPendingOperations: vi.fn().mockResolvedValue([]),
    replicaUpdateOperationStatus: vi.fn().mockResolvedValue(undefined),
    replicaRecordOperationFailure: vi.fn().mockResolvedValue(undefined),
    replicaRemoveOperation: vi.fn().mockResolvedValue(undefined),
    hostedVaultAssetDataUrl: vi.fn(),
    replicaCacheDocument: vi.fn().mockResolvedValue(undefined),
    replicaCacheAsset: vi.fn().mockResolvedValue(undefined),
    replicaCachedContentStatus: vi.fn(),
    replicaReadCachedAsset: vi.fn(),
    replicaReadLogicComponents: vi.fn().mockResolvedValue([]),
    replicaWriteLogicComponents: vi.fn().mockResolvedValue(undefined),
    replicaCleanup: vi.fn().mockResolvedValue({ removedFiles: 2, freedBytes: 10, remainingBytes: 5 }),
  },
}));

const hostedVault: HostedVaultMeta = {
  id: 'hosted-vault',
  kind: 'hosted',
  hostedVaultId: 'hosted-vault',
  serverUrl: 'https://collab.example.test',
  role: 'editor',
  name: 'Hosted Vault',
  path: 'hosted://hosted-vault',
  lastOpened: 1,
  isEncrypted: false,
  capabilities: ['vault.read', 'vault.offlineCopy'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
    manifestSequence: 4,
    lastSyncedAt: '2026-06-17T00:00:00Z',
    offlineAvailableAt: null,
    status: 'idle',
  });
  vi.mocked(tauriCommands.replicaCachedContentStatus).mockResolvedValue({
    present: false,
    matchesExpectedHash: false,
    actualSha256: null,
    sizeBytes: null,
  });
});

describe('vaultReplica', () => {
  it('initialSyncState carries the manifest sequence and idle status', () => {
    const state = initialSyncState(12);
    expect(state.manifestSequence).toBe(12);
    expect(state.status).toBe('idle');
    expect(state.lastSyncedAt).not.toBeNull();
    expect(state.offlineAvailableAt).toBeNull();
  });

  it('runs a bounded cache cleanup pass with the default budget', async () => {
    const report = await cleanupReplicaCache(hostedVault);
    expect(tauriCommands.replicaCleanup).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      REPLICA_CACHE_BUDGET_BYTES,
    );
    expect(report.removedFiles).toBe(2);
  });

  it('forwards an explicit cleanup budget', async () => {
    await cleanupReplicaCache(hostedVault, 1024);
    expect(tauriCommands.replicaCleanup).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      1024,
    );
  });

  it('detects connectivity-shaped errors without swallowing validation failures', () => {
    expect(isLikelyConnectivityError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isLikelyConnectivityError(new Error('Too many requests. Slow down and try again shortly.'))).toBe(true);
    expect(isLikelyConnectivityError(new Error('RATE_LIMITED'))).toBe(true);
    expect(isLikelyConnectivityError(new Error('manifest_conflict'))).toBe(false);
  });

  it('routes replica mutation events by kind and path', () => {
    const broad = vi.fn();
    const manifestOnly = vi.fn();
    const unsubscribeBroad = onReplicaMutated(broad);
    const unsubscribeManifest = onReplicaMutated(manifestOnly, { kinds: ['manifest'] });

    emitReplicaMutated({ kind: 'content', fileIds: ['file-1'], relativePaths: ['Notes/Test.md'] });
    emitReplicaMutated({ kind: 'manifest', fileIds: ['file-2'], relativePaths: ['Notes/Other.md'] });

    expect(broad).toHaveBeenCalledTimes(2);
    expect(manifestOnly).toHaveBeenCalledTimes(1);
    expect(manifestOnly).toHaveBeenCalledWith({
      kind: 'manifest',
      fileIds: ['file-2'],
      relativePaths: ['Notes/Other.md'],
    });
    expect(replicaMutationAffectsPath({ kind: 'manifest', relativePaths: ['Notes/Test.md'] }, 'Notes/Test.md')).toBe(true);
    expect(replicaMutationAffectsPath({ kind: 'manifest', relativePaths: ['Notes/Other.md'] }, 'Notes/Test.md')).toBe(false);
    expect(replicaMutationAffectsPath({ kind: 'manifest' }, 'Notes/Test.md')).toBe(true);

    unsubscribeBroad();
    unsubscribeManifest();
  });

  it('treats a vault whose server is not the connected one as offline (queueable)', () => {
    // Connected to a different server than the vault belongs to: for this vault
    // that is effectively offline, so edits must queue rather than hard-fail.
    expect(isLikelyConnectivityError(new Error('This hosted vault belongs to a different Collab server.'))).toBe(true);
    // No server connected at all when opening a hosted vault.
    expect(isLikelyConnectivityError(new Error('Connect to the Collab server before opening hosted vaults.'))).toBe(true);
    // A genuine access-revocation must still not be mistaken for connectivity.
    expect(isLikelyConnectivityError(new Error('You do not have permission to perform this vault operation.'))).toBe(false);
  });

  it('classifies irreconcilable replay failures for recovery flows', () => {
    expect(classifyPendingOperationFailure(new Error('The vault manifest has changed since the supplied sequence.'))).toEqual({
      code: 'manifest_conflict',
      message: 'The vault manifest has changed since the supplied sequence.',
    });
    expect(classifyPendingOperationFailure(new Error('You do not have permission to perform this vault operation.')).code)
      .toBe('permission_revoked');
  });

  it('seeds the replica from the fetched server manifest', async () => {
    const manifest = { vaultId: 'hosted-vault', sequence: 9, files: [] };
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue(manifest);

    await seedReplicaFromManifest(hostedVault);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/manifest',
    );
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted Vault',
      manifest,
      expect.objectContaining({ manifestSequence: 9, status: 'idle' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
  });

  it('propagates fetch failures so callers can treat seeding as best-effort', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValue(new Error('offline'));
    await expect(seedReplicaFromManifest(hostedVault)).rejects.toThrow('offline');
    expect(tauriCommands.replicaSeed).not.toHaveBeenCalled();
  });

  it('downloads active document and asset bodies for explicit offline availability', async () => {
    const progress = vi.fn();
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 9,
      files: [
        { id: 'doc-1', kind: 'document', state: 'active' },
        { id: 'asset-1', kind: 'asset', state: 'active' },
        { id: 'folder-1', kind: 'folder', state: 'active' },
        { id: 'old-doc', kind: 'document', state: 'trashed' },
      ],
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce({ content: '# Cached' });
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(manifest);
    vi.mocked(tauriCommands.hostedVaultAssetDataUrl).mockResolvedValue('data:image/png;base64,aW1n');

    const report = await makeHostedVaultAvailableOffline(hostedVault, progress);

    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'doc-1',
      '# Cached',
    );
    expect(tauriCommands.replicaCacheAsset).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'asset-1',
      'aW1n',
    );
    expect(report).toEqual({ documentsCached: 1, assetsCached: 1, skipped: 0, alreadyCached: 0 });
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect(tauriCommands.replicaWriteSyncState).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      expect.objectContaining({ manifestSequence: 9, offlineAvailableAt: expect.any(String) }),
    );
  });

  it('stops offline caching after the first rate-limited file request', async () => {
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 9,
      files: [
        { id: 'doc-1', kind: 'document', state: 'active' },
        { id: 'doc-2', kind: 'document', state: 'active' },
        { id: 'doc-3', kind: 'document', state: 'active' },
      ],
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(manifest)
      .mockRejectedValueOnce(new Error('Too many requests. Slow down and try again shortly.'));
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(manifest);

    await expect(makeHostedVaultAvailableOffline(hostedVault)).rejects.toThrow('Too many requests');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledTimes(2);
    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalledWith(
      hostedVault.serverUrl,
      'GET',
      '/api/v1/vaults/hosted-vault/files/doc-2',
    );
    expect(tauriCommands.replicaCacheDocument).not.toHaveBeenCalled();
  });

  it('resumes offline availability by skipping valid cached file bodies', async () => {
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 9,
      files: [
        {
          id: 'doc-ready',
          kind: 'document',
          state: 'active',
          currentRevision: { contentHash: 'ready-hash' },
        },
        {
          id: 'doc-missing',
          kind: 'document',
          state: 'active',
          currentRevision: { contentHash: 'missing-hash' },
        },
      ],
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce({ content: '# Missing' });
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(manifest);
    vi.mocked(tauriCommands.replicaCachedContentStatus)
      .mockResolvedValueOnce({
        present: true,
        matchesExpectedHash: true,
        actualSha256: 'ready-hash',
        sizeBytes: 10,
      })
      .mockResolvedValueOnce({
        present: false,
        matchesExpectedHash: false,
        actualSha256: null,
        sizeBytes: null,
      });

    const report = await makeHostedVaultAvailableOffline(hostedVault);

    expect(tauriCommands.replicaCachedContentStatus).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'doc-ready',
      'document',
      'ready-hash',
    );
    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalledWith(
      hostedVault.serverUrl,
      'GET',
      '/api/v1/vaults/hosted-vault/files/doc-ready',
    );
    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledTimes(1);
    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'doc-missing',
      '# Missing',
    );
    expect(report).toEqual({ documentsCached: 1, assetsCached: 0, skipped: 0, alreadyCached: 1 });
  });

  it('merges manifest delta entries into the cached replica manifest', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue({
      vaultId: 'hosted-vault',
      sequence: 9,
      files: [
        { id: 'file-1', relativePath: 'Old.md', state: 'active' },
        { id: 'file-2', relativePath: 'Keep.md', state: 'active' },
      ],
    });
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 9,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({
      vaultId: 'hosted-vault',
      baseSequence: 9,
      sequence: 10,
      changedFiles: [{ id: 'file-1', relativePath: 'Renamed.md', state: 'active' }],
    });

    const manifest = await syncReplicaManifestDelta(hostedVault);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/manifest/delta?since=9',
    );
    expect(manifest.sequence).toBe(10);
    expect(manifest.files).toEqual([
      { id: 'file-1', relativePath: 'Renamed.md', state: 'active' },
      { id: 'file-2', relativePath: 'Keep.md', state: 'active' },
    ]);
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted Vault',
      manifest,
      expect.objectContaining({ manifestSequence: 10, status: 'idle' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
  });

  it('refreshes changed file bodies when applying a delta to a full offline copy', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue({
      vaultId: 'hosted-vault',
      sequence: 9,
      files: [{ id: 'file-1', kind: 'document', relativePath: 'Note.md', state: 'active' }],
    });
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 9,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: '2026-06-17T00:05:00Z',
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({
        vaultId: 'hosted-vault',
        baseSequence: 9,
        sequence: 10,
        changedFiles: [{
          id: 'file-1',
          kind: 'document',
          relativePath: 'Note.md',
          state: 'active',
          currentRevision: { contentHash: 'updated-hash' },
        }],
      })
      .mockResolvedValueOnce({ content: '# Updated on server' });

    await syncReplicaManifestDelta(hostedVault);

    expect(tauriCommands.replicaCachedContentStatus).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'file-1',
      'document',
      'updated-hash',
    );
    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'file-1',
      '# Updated on server',
    );
    expect(tauriCommands.replicaWriteSyncState).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      expect.objectContaining({ manifestSequence: 10, offlineAvailableAt: expect.any(String) }),
    );
  });

  it('falls back to full seeding when there is no cached manifest', async () => {
    const manifest = { vaultId: 'hosted-vault', sequence: 11, files: [] };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
    vi.mocked(tauriCommands.replicaReadManifest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(manifest);
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 0,
      lastSyncedAt: null,
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue(manifest);

    await expect(syncReplicaManifestDelta(hostedVault)).resolves.toEqual(manifest);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/manifest',
    );
  });

  it('does not emit a replica mutation after a zero-change native sync', async () => {
    const commands = tauriCommands as typeof tauriCommands & Record<string, unknown>;
    const originalRun = commands.backgroundJobRun;
    const originalGet = commands.backgroundJobGet;
    commands.backgroundJobRun = vi.fn().mockResolvedValue({
      id: 'job-1',
      idempotencyKey: 'foreground:hosted-vault:test',
      kind: 'replica_sync',
      serverUrl: hostedVault.serverUrl,
      profileId: null,
      vaultId: hostedVault.hostedVaultId,
      trigger: 'foreground',
      attempt: 1,
      status: 'succeeded',
      createdAt: '2026-07-27T12:00:00Z',
      startedAt: '2026-07-27T12:00:00Z',
      finishedAt: '2026-07-27T12:00:01Z',
      nextRetryAt: null,
      progress: { completed: 1, total: 1, detail: null },
      changed: 0,
      summary: 'Offline replicas are already up to date',
      errorCategory: null,
      errorMessage: null,
      retryable: false,
    });
    commands.backgroundJobGet = vi.fn();
    const manifest = { vaultId: 'hosted-vault', sequence: 9, files: [] };
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(manifest);
    const listener = vi.fn();
    const unsubscribe = onReplicaMutated(listener);

    try {
      await expect(syncReplicaManifestDelta(hostedVault)).resolves.toEqual(manifest);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      commands.backgroundJobRun = originalRun;
      commands.backgroundJobGet = originalGet;
    }
  });

  it('enqueues pending operations with stable replay metadata', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');

    const operation = await enqueuePendingOperation(hostedVault, {
      kind: 'rename',
      fileId: 'file-1',
      relativePath: 'Old.md',
      baseManifestSequence: 8,
      payload: { operationType: 'rename', targetFileId: 'file-1', name: 'New.md' },
    });

    expect(operation).toEqual(expect.objectContaining({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'rename',
      fileId: 'file-1',
      relativePath: 'Old.md',
      baseManifestSequence: 8,
      status: 'pending',
    }));
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      operation,
    );
  });

  it('replays pending create, edit, and structural operations with temporary file-id mapping', async () => {
    const operations = [
      {
        id: 'op-create',
        kind: 'create' as const,
        fileId: 'offline-file-1',
        relativePath: 'Draft.md',
        payload: {
          parentId: null,
          name: 'Draft.md',
          kind: 'document',
          documentType: 'note',
          content: '',
          tempFileId: 'offline-file-1',
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:00Z',
        status: 'pending' as const,
      },
      {
        id: 'op-edit',
        kind: 'edit' as const,
        fileId: 'offline-file-1',
        relativePath: 'Draft.md',
        payload: {
          targetFileId: 'offline-file-1',
          expectedRevisionSequence: 0,
          content: '# Draft',
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:01Z',
        status: 'pending' as const,
      },
      {
        id: 'op-rename',
        kind: 'rename' as const,
        fileId: 'offline-file-1',
        relativePath: 'Draft.md',
        payload: {
          clientOperationId: '11111111-1111-4111-8111-111111111111',
          baseManifestSequence: 8,
          operationType: 'rename',
          targetFileId: 'offline-file-1',
          name: 'Final.md',
          parentId: null,
          removeReferences: false,
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:02Z',
        status: 'pending' as const,
      },
    ];
    const seededManifest = { vaultId: 'hosted-vault', sequence: 12, files: [] };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue(operations);
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({ id: 'file-123' })
      .mockResolvedValueOnce({ file: { id: 'file-123' }, content: '# Draft' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(seededManifest);

    await replayPendingOperations(hostedVault);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files',
      {
        parentId: null,
        name: 'Draft.md',
        kind: 'document',
        documentType: 'note',
        content: '',
      },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files/file-123/revisions',
      { expectedRevisionSequence: 0, content: '# Draft' },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      3,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/operations',
      {
        clientOperationId: '11111111-1111-4111-8111-111111111111',
        baseManifestSequence: 8,
        operationType: 'rename',
        targetFileId: 'file-123',
        name: 'Final.md',
        parentId: null,
        removeReferences: false,
      },
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-create',
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-edit',
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-rename',
    );
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted Vault',
      seededManifest,
      expect.objectContaining({ manifestSequence: 12, status: 'idle' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
  });

  it('three-way merges a queued sheet edit against a newer hosted revision', async () => {
    const base = createWorkbookFixture({
      rows: 2,
      columns: 2,
      populatedRows: 0,
      populatedColumns: 0,
    });
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.worksheets[0].cells[sheetCellKey('r1', 'c1')] = { value: 'offline', valueType: 'text' };
    remote.worksheets[0].cells[sheetCellKey('r2', 'c2')] = { value: 'server', valueType: 'text' };
    const operations = [{
      id: 'op-sheet-edit',
      kind: 'edit' as const,
      fileId: 'sheet-1',
      relativePath: 'Budget.sheet',
      payload: {
        targetFileId: 'sheet-1',
        expectedRevisionSequence: 2,
        content: serializeSheetDocument(local),
        baseContent: serializeSheetDocument(base),
      },
      baseManifestSequence: 8,
      createdAt: '2026-06-18T08:00:00Z',
      status: 'pending' as const,
    }];
    const seededManifest = { vaultId: 'hosted-vault', sequence: 10, files: [] };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue(operations);
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockRejectedValueOnce(new Error('REVISION_CONFLICT: revision has changed'))
      .mockResolvedValueOnce({
        file: { currentRevision: { sequence: 3 } },
        content: serializeSheetDocument(remote),
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(seededManifest);

    await replayPendingOperations(hostedVault);

    const retry = vi.mocked(tauriCommands.hostedVaultRequest).mock.calls[2];
    expect(retry?.slice(0, 3)).toEqual([
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files/sheet-1/revisions',
    ]);
    const retryPayload = retry?.[3] as { expectedRevisionSequence: number; content: string };
    expect(retryPayload.expectedRevisionSequence).toBe(3);
    const merged = JSON.parse(retryPayload.content);
    expect(merged.worksheets[0].cells['r1:c1'].value).toBe('offline');
    expect(merged.worksheets[0].cells['r2:c2'].value).toBe('server');
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-sheet-edit',
    );
  });

  it('replays pending asset uploads from the replica asset cache', async () => {
    const operations = [
      {
        id: 'op-folder',
        kind: 'create' as const,
        fileId: 'offline-folder-1',
        relativePath: 'Pictures',
        payload: {
          parentId: null,
          name: 'Pictures',
          kind: 'folder',
          documentType: null,
          content: '',
          tempFileId: 'offline-folder-1',
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:00Z',
        status: 'pending' as const,
      },
      {
        id: 'op-upload',
        kind: 'assetUpload' as const,
        fileId: 'offline-asset-1',
        relativePath: 'Pictures/diagram.png',
        payload: {
          parentId: 'offline-folder-1',
          name: 'diagram.png',
          mediaType: 'image/png',
          expectedHash: 'abc123',
          assetCacheId: 'offline-asset-1',
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:01Z',
        status: 'pending' as const,
      },
    ];
    const seededManifest = { vaultId: 'hosted-vault', sequence: 12, files: [] };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue(operations);
    vi.mocked(tauriCommands.replicaReadCachedAsset).mockResolvedValue('aW1n');
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({ id: 'folder-123' })
      .mockResolvedValueOnce({ id: 'asset-123' })
      .mockResolvedValueOnce(seededManifest);

    await replayPendingOperations(hostedVault);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/uploads',
      {
        parentId: 'folder-123',
        name: 'diagram.png',
        mediaType: 'image/png',
        contentBase64: 'aW1n',
        expectedHash: 'abc123',
      },
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-upload',
    );
  });

  it('replays offline logic component saves and deletes and refreshes the cached library', async () => {
    const component = {
      id: 'component-1',
      name: 'Half adder',
      version: 2,
      createdAt: 1,
      updatedAt: 2,
      ports: [],
      nodes: [],
      wires: [],
    };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      {
        id: 'op-component-save',
        kind: 'logicComponentSave',
        fileId: null,
        relativePath: null,
        payload: { component },
        baseManifestSequence: 8,
        createdAt: '2026-07-16T08:00:00Z',
        status: 'pending',
      },
      {
        id: 'op-component-delete',
        kind: 'logicComponentDelete',
        fileId: null,
        relativePath: null,
        payload: { componentId: 'component-old' },
        baseManifestSequence: 8,
        createdAt: '2026-07-16T08:00:01Z',
        status: 'pending',
      },
    ]);
    vi.mocked(tauriCommands.replicaReadLogicComponents).mockResolvedValue([]);
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({ ...component, version: 3 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ vaultId: 'hosted-vault', sequence: 9, files: [] });

    await replayPendingOperations(hostedVault);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      hostedVault.serverUrl,
      'POST',
      '/api/v1/vaults/hosted-vault/logic-components',
      component,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      hostedVault.serverUrl,
      'DELETE',
      '/api/v1/vaults/hosted-vault/logic-components/component-old',
    );
    expect(tauriCommands.replicaWriteLogicComponents).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      [{ ...component, version: 3 }],
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'op-component-save',
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      'op-component-delete',
    );
  });

  it('does not fetch a full manifest when there are no pending operations to replay', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);

    await replayPendingOperations(hostedVault);

    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalled();
    expect(tauriCommands.replicaSeed).not.toHaveBeenCalled();
  });

  it('records failed replay operations with recovery metadata and stops dependent replay', async () => {
    const operations = [
      {
        id: 'op-rename',
        kind: 'rename' as const,
        fileId: 'file-1',
        relativePath: 'Old.md',
        payload: {
          clientOperationId: '11111111-1111-4111-8111-111111111111',
          baseManifestSequence: 8,
          operationType: 'rename',
          targetFileId: 'file-1',
          name: 'New.md',
          parentId: null,
          removeReferences: false,
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:00Z',
        status: 'pending' as const,
      },
      {
        id: 'op-edit',
        kind: 'edit' as const,
        fileId: 'file-1',
        relativePath: 'Old.md',
        payload: {
          targetFileId: 'file-1',
          expectedRevisionSequence: 1,
          content: '# Later',
        },
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:01Z',
        status: 'pending' as const,
      },
    ];
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue(operations);
    vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValue(
      new Error('The vault manifest has changed since the supplied sequence.'),
    );

    await replayPendingOperations(hostedVault);

    expect(tauriCommands.replicaRecordOperationFailure).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-rename',
      'manifest_conflict',
      'The vault manifest has changed since the supplied sequence.',
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledTimes(1);
    expect(tauriCommands.replicaRemoveOperation).not.toHaveBeenCalled();
  });

  it('lists failed operations with recommended recovery actions', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      {
        id: 'op-1',
        kind: 'rename',
        fileId: 'file-1',
        relativePath: 'Old.md',
        payload: {},
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:00Z',
        status: 'failed',
        failureCode: 'manifest_conflict',
        failureMessage: 'The vault manifest has changed since the supplied sequence.',
      },
      {
        id: 'op-2',
        kind: 'edit',
        fileId: 'file-2',
        relativePath: 'Other.md',
        payload: {},
        baseManifestSequence: 8,
        createdAt: '2026-06-18T08:00:01Z',
        status: 'pending',
      },
    ]);

    await expect(listPendingOperationRecoveries(hostedVault)).resolves.toEqual([
      expect.objectContaining({
        failure: {
          code: 'manifest_conflict',
          message: 'The vault manifest has changed since the supplied sequence.',
        },
        recommendedAction: 'retry-after-refresh',
      }),
    ]);
  });

  it('retries or discards failed pending operations through the replica queue', async () => {
    await retryPendingOperation(hostedVault, 'op-1');
    await discardPendingOperation(hostedVault, 'op-2');

    expect(tauriCommands.replicaUpdateOperationStatus).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-1',
      'pending',
    );
    expect(tauriCommands.replicaRemoveOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'op-2',
    );
  });
});
