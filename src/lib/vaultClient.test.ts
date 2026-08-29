import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedVaultMeta, LocalVaultMeta } from '../types/vault';

import { tauriCommands } from './tauri';
import {
  createVaultClient,
  HOSTED_VAULT_CAPABILITIES,
  HostedVaultClient,
  LOCAL_VAULT_CAPABILITIES,
  LocalVaultClient,
  requireRuntimeCapability,
} from './vaultClient';

vi.mock('./tauri', () => ({
  tauriCommands: {
    listVaultFiles: vi.fn(),
    readNote: vi.fn(),
    writeNote: vi.fn(),
    createNote: vi.fn(),
    createFolder: vi.fn(),
    previewRenameMove: vi.fn(),
    renameNote: vi.fn(),
    deleteNote: vi.fn(),
    listFileReferences: vi.fn(),
    moveNoteToTrash: vi.fn(),
    listTrashEntries: vi.fn(),
    restoreTrashedItem: vi.fn(),
    purgeTrashedItem: vi.fn(),
    purgeAllTrash: vi.fn(),
    searchNotes: vi.fn(),
    createSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    readSnapshot: vi.fn(),
    restoreSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    clearSnapshotHistory: vi.fn(),
    readNoteAssetDataUrl: vi.fn(),
    readPdfSidecarState: vi.fn(),
    writePdfSidecarState: vi.fn(),
    readFileForUpload: vi.fn(),
    saveGeneratedImage: vi.fn(),
    hostedVaultRequest: vi.fn(),
    hostedVaultAssetDataUrl: vi.fn(),
    hostedVaultUploadFile: vi.fn(),
    hostedUserDirectory: vi.fn(),
    replicaCacheDocument: vi.fn().mockResolvedValue(undefined),
    replicaReadManifest: vi.fn(),
    replicaReadSyncState: vi.fn(),
    replicaWriteSyncState: vi.fn().mockResolvedValue(undefined),
    replicaSeed: vi.fn().mockResolvedValue(undefined),
    replicaEnqueueOperation: vi.fn().mockResolvedValue(undefined),
    replicaListPendingOperations: vi.fn().mockResolvedValue([]),
    replicaUpdateOperationStatus: vi.fn().mockResolvedValue(undefined),
    replicaRecordOperationFailure: vi.fn().mockResolvedValue(undefined),
    replicaRemoveOperation: vi.fn().mockResolvedValue(undefined),
    replicaCachedContentStatus: vi.fn(),
    replicaCacheAsset: vi.fn().mockResolvedValue(undefined),
    replicaReadCachedAsset: vi.fn(),
    watchVault: vi.fn(),
    unwatchVault: vi.fn(),
    unlockVault: vi.fn(),
    enableVaultEncryption: vi.fn(),
    disableVaultEncryption: vi.fn(),
    changeVaultPassword: vi.fn(),
    importAssetIntoVault: vi.fn(),
    exportVault: vi.fn(),
    listLogicComponents: vi.fn(),
    saveLogicComponent: vi.fn(),
    deleteLogicComponent: vi.fn(),
    replicaReadCachedDocument: vi.fn(),
    replicaReadLogicComponents: vi.fn().mockResolvedValue([]),
    replicaWriteLogicComponents: vi.fn().mockResolvedValue(undefined),
  },
}));

const vault: LocalVaultMeta = {
  id: 'local-vault',
  kind: 'local',
  name: 'Local vault',
  path: '/vault',
  lastOpened: 1,
  isEncrypted: false,
};

const hostedVault: HostedVaultMeta = {
  id: 'hosted-vault',
  kind: 'hosted',
  hostedVaultId: 'hosted-vault',
  serverUrl: 'https://collab.example.test',
  role: 'editor',
  name: 'Hosted vault',
  path: 'hosted://hosted-vault',
  lastOpened: 1,
  isEncrypted: false,
  capabilities: ['vault.read', 'vault.offlineCopy'],
};

const rootFolder = {
  id: 'folder-1',
  parentId: null,
  name: 'Notes',
  relativePath: 'Notes',
  kind: 'folder' as const,
  documentType: null,
  state: 'active' as const,
  currentRevision: null,
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T08:00:00Z',
};

const hostedDocument = {
  id: 'file-1',
  parentId: 'folder-1',
  name: 'Test.md',
  relativePath: 'Notes/Test.md',
  kind: 'document' as const,
  documentType: 'note' as const,
  state: 'active' as const,
  currentRevision: {
    id: 'revision-3',
    sequence: 3,
    contentHash: 'hash-3',
    sizeBytes: 6,
    createdByDisplayName: 'Alice',
    createdAt: '2026-06-11T08:00:00Z',
  },
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T08:00:00Z',
};

const hostedPdf = {
  id: 'pdf-1',
  parentId: null,
  name: 'doc.pdf',
  relativePath: 'doc.pdf',
  kind: 'asset' as const,
  documentType: null,
  state: 'active' as const,
  currentRevision: {
    id: 'pdf-rev-1',
    sequence: 1,
    contentHash: 'pdf-hash',
    sizeBytes: 10,
    createdByDisplayName: 'Alice',
    createdAt: '2026-06-11T08:00:00Z',
  },
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T08:00:00Z',
};

function mockHostedManifest(sequence = 8) {
  return { vaultId: 'hosted-vault', sequence, files: [rootFolder, hostedDocument, hostedPdf] };
}

describe('LocalVaultClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('advertises local runtime capabilities', () => {
    const client = new LocalVaultClient(vault);
    expect(client.kind).toBe('local');
    expect(client.id).toBe('local-vault');
    expect(client.capabilities).toEqual(LOCAL_VAULT_CAPABILITIES);
    expect(client.capabilities.hostedMemberships).toBe(false);
    expect(client.runtime).toEqual({
      watch: expect.any(Object),
      encryption: expect.any(Object),
      externalAssetImport: expect.any(Object),
      archiveExport: expect.any(Object),
      logicComponents: expect.any(Object),
    });
  });

  it('routes native-only operations through explicit local runtime capabilities', async () => {
    const client = new LocalVaultClient(vault);
    await requireRuntimeCapability(client, 'watch').start();
    await requireRuntimeCapability(client, 'encryption').unlock('password');
    await requireRuntimeCapability(client, 'externalAssetImport').import(
      '/tmp/image.png',
      'Pictures',
    );
    await requireRuntimeCapability(client, 'archiveExport').exportTo('/tmp/vault.zip');

    expect(tauriCommands.watchVault).toHaveBeenCalledWith('/vault');
    expect(tauriCommands.unlockVault).toHaveBeenCalledWith('/vault', 'password');
    expect(tauriCommands.importAssetIntoVault).toHaveBeenCalledWith(
      '/vault',
      '/tmp/image.png',
      'Pictures',
    );
    expect(tauriCommands.exportVault).toHaveBeenCalledWith('/vault', '/tmp/vault.zip');
  });

  it('routes local logic component library operations through Tauri wrappers', async () => {
    const component = {
      id: 'component-1',
      name: 'Half adder',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [],
      nodes: [],
      wires: [],
    };
    vi.mocked(tauriCommands.listLogicComponents).mockResolvedValue([component]);
    vi.mocked(tauriCommands.saveLogicComponent).mockResolvedValue({ ...component, version: 2 });
    vi.mocked(tauriCommands.deleteLogicComponent).mockResolvedValue(undefined);

    const logicComponents = new LocalVaultClient(vault).runtime.logicComponents!;
    await expect(logicComponents.list()).resolves.toEqual([component]);
    await expect(logicComponents.save(component)).resolves.toEqual({ ...component, version: 2 });
    await expect(logicComponents.delete('component-1')).resolves.toBeUndefined();

    expect(tauriCommands.listLogicComponents).toHaveBeenCalledWith('/vault');
    expect(tauriCommands.saveLogicComponent).toHaveBeenCalledWith('/vault', component);
    expect(tauriCommands.deleteLogicComponent).toHaveBeenCalledWith('/vault', 'component-1');
  });

  it('maps local document hashes to opaque client versions', async () => {
    vi.mocked(tauriCommands.readNote).mockResolvedValue({
      content: '# Test',
      hash: 'hash-1',
      modifiedAt: 123,
    });
    vi.mocked(tauriCommands.writeNote).mockResolvedValue({
      hash: 'hash-2',
      mergedContent: '# Merged',
    });
    const client = new LocalVaultClient(vault);

    await expect(client.readDocument('Notes/Test.md')).resolves.toEqual({
      relativePath: 'Notes/Test.md',
      content: '# Test',
      version: 'hash-1',
      modifiedAt: 123,
    });
    await expect(
      client.writeDocument('Notes/Test.md', '# Next', 'hash-1', '# Test'),
    ).resolves.toEqual({
      version: 'hash-2',
      mergedContent: '# Merged',
      conflict: undefined,
    });
    expect(tauriCommands.writeNote).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      '# Next',
      'hash-1',
      '# Test',
    );
  });

  it('delegates file, trash, search, and history operations through typed Tauri commands', async () => {
    vi.mocked(tauriCommands.restoreSnapshot).mockResolvedValue({ hash: 'restored-hash' });
    const client = new LocalVaultClient(vault);
    await client.listFiles();
    await client.createDocument('Test.md');
    await client.createFolder('Notes');
    await client.previewRenameMove('Test.md', 'Notes/Test.md');
    await client.renameMove('Test.md', 'Notes/Test.md', true);
    await client.moveToTrash('Notes/Test.md', true);
    await client.deletePermanently('Old.md', true);
    await client.listReferences('Notes/Test.md');
    await client.listTrash();
    await client.restoreTrash('trash-1', 'Notes/Test.md');
    await client.purgeTrash('trash-2', true);
    await client.purgeAllTrash();
    await client.search('test');
    await client.createSnapshot('Notes/Test.md', '# Test', 'user-1', 'Alice', 'Checkpoint');
    await client.listSnapshots('Notes/Test.md');
    await client.readSnapshot('Notes/Test.md', 'snapshot-1');
    await client.restoreSnapshot('Notes/Test.md', 'snapshot-1', 'user-1', 'Alice');
    await client.deleteSnapshot('Notes/Test.md', 'snapshot-1');
    await client.clearSnapshotHistory('Notes/Test.md');
    await client.readAssetDataUrl('Pictures/diagram.png');

    expect(tauriCommands.listVaultFiles).toHaveBeenCalledWith('/vault');
    expect(tauriCommands.createNote).toHaveBeenCalledWith('/vault', 'Test.md');
    expect(tauriCommands.createFolder).toHaveBeenCalledWith('/vault', 'Notes');
    expect(tauriCommands.previewRenameMove).toHaveBeenCalledWith(
      '/vault',
      'Test.md',
      'Notes/Test.md',
    );
    expect(tauriCommands.renameNote).toHaveBeenCalledWith(
      '/vault',
      'Test.md',
      'Notes/Test.md',
      true,
    );
    expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      undefined,
      undefined,
      true,
    );
    expect(tauriCommands.deleteNote).toHaveBeenCalledWith('/vault', 'Old.md', true);
    expect(tauriCommands.listFileReferences).toHaveBeenCalledWith('/vault', 'Notes/Test.md');
    expect(tauriCommands.listTrashEntries).toHaveBeenCalledWith('/vault');
    expect(tauriCommands.restoreTrashedItem).toHaveBeenCalledWith(
      '/vault',
      'trash-1',
      'Notes/Test.md',
    );
    expect(tauriCommands.purgeTrashedItem).toHaveBeenCalledWith('/vault', 'trash-2', true);
    expect(tauriCommands.purgeAllTrash).toHaveBeenCalledWith('/vault');
    expect(tauriCommands.searchNotes).toHaveBeenCalledWith('/vault', 'test');
    expect(tauriCommands.createSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      '# Test',
      'user-1',
      'Alice',
      'Checkpoint',
    );
    expect(tauriCommands.listSnapshots).toHaveBeenCalledWith('/vault', 'Notes/Test.md');
    expect(tauriCommands.readSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      'snapshot-1',
    );
    expect(tauriCommands.restoreSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      'snapshot-1',
      'user-1',
      'Alice',
    );
    expect(tauriCommands.deleteSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Notes/Test.md',
      'snapshot-1',
    );
    expect(tauriCommands.clearSnapshotHistory).toHaveBeenCalledWith('/vault', 'Notes/Test.md');
    expect(tauriCommands.readNoteAssetDataUrl).toHaveBeenCalledWith(
      '/vault',
      'Pictures/diagram.png',
    );
  });
});

describe('HostedVaultClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultAssetDataUrl).mockReset();
    vi.mocked(tauriCommands.hostedVaultUploadFile).mockReset();
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(null);
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
  });

  it('advertises online hosted capabilities and builds a nested file tree', async () => {
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({
      vaultId: 'hosted-vault',
      baseSequence: 8,
      sequence: 8,
      changedFiles: [],
    });
    const client = new HostedVaultClient(hostedVault);

    expect(client.capabilities).toEqual(HOSTED_VAULT_CAPABILITIES);
    expect(client.runtime).toEqual({
      externalAssetImport: expect.any(Object),
      logicComponents: expect.any(Object),
      members: expect.any(Object),
    });
    await expect(client.listFiles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'Notes',
          isFolder: true,
          children: [expect.objectContaining({ relativePath: 'Notes/Test.md', size: 6 })],
        }),
      ]),
    );
  });

  it('derives a lightweight note index from the manifest documents', async () => {
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({
      vaultId: 'hosted-vault',
      baseSequence: 8,
      sequence: 8,
      changedFiles: [],
    });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.buildNoteIndex()).resolves.toEqual([
      {
        relativePath: 'Notes/Test.md',
        title: 'Test',
        tags: [],
        wikilinksOut: [],
        modifiedAt: expect.any(Number),
        wordCount: 0,
        hash: 'hash-3',
      },
    ]);
  });

  it('maps hosted revision sequences to opaque document versions', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ file: hostedDocument, content: '# Test' })
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({
        file: {
          ...hostedDocument,
          currentRevision: { ...hostedDocument.currentRevision, id: 'revision-4', sequence: 4 },
        },
        content: '# Next',
      });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readDocument('Notes/Test.md')).resolves.toEqual({
      relativePath: 'Notes/Test.md',
      content: '# Test',
      version: '3',
      modifiedAt: Date.parse('2026-06-11T08:00:00Z'),
      source: 'network',
      manifestSequence: 8,
      contentHash: 'hash-3',
    });
    await expect(client.writeDocument('Notes/Test.md', '# Next', '3')).resolves.toEqual({
      version: '4',
    });
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files/file-1/revisions',
      { expectedRevisionSequence: 3, content: '# Next' },
    );
  });

  it('routes hosted logic component library operations through vault endpoints', async () => {
    const component = {
      id: 'component-1',
      name: 'Half adder',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [],
      nodes: [],
      wires: [],
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce([component])
      .mockResolvedValueOnce({ ...component, version: 2 })
      .mockResolvedValueOnce(undefined);

    const logicComponents = new HostedVaultClient(hostedVault).runtime.logicComponents!;
    await expect(logicComponents.list()).resolves.toEqual([component]);
    await expect(logicComponents.save(component)).resolves.toEqual({ ...component, version: 2 });
    await expect(logicComponents.delete('component 1')).resolves.toBeUndefined();

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/logic-components',
      undefined,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/logic-components',
      component,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      3,
      'https://collab.example.test',
      'DELETE',
      '/api/v1/vaults/hosted-vault/logic-components/component%201',
      undefined,
    );
  });

  it('uses and updates hosted logic components through the offline replica', async () => {
    const component = {
      id: 'component-1',
      name: 'Half adder',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [],
      nodes: [],
      wires: [],
    };
    vi.mocked(tauriCommands.replicaReadLogicComponents).mockResolvedValue([component]);
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValue(
      new Error('Network connection unavailable'),
    );

    const logicComponents = new HostedVaultClient(hostedVault).runtime.logicComponents!;
    await expect(logicComponents.list()).resolves.toEqual([component]);
    await expect(
      logicComponents.save({ ...component, description: 'Updated' }),
    ).resolves.toMatchObject({
      id: 'component-1',
      version: 2,
      description: 'Updated',
    });
    await expect(logicComponents.delete('component-1')).resolves.toBeUndefined();

    expect(tauriCommands.replicaWriteLogicComponents).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      expect.any(Array),
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      expect.objectContaining({ kind: 'logicComponentSave', baseManifestSequence: 8 }),
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      hostedVault.serverUrl,
      hostedVault.hostedVaultId,
      expect.objectContaining({ kind: 'logicComponentDelete', baseManifestSequence: 8 }),
    );
  });

  it('queues a document edit offline when connected to a different server than the vault', async () => {
    // Reads resolve from the seeded replica manifest (no network), and the
    // revision POST is rejected because the connected session targets another
    // server. The edit must be queued as a pending operation, not thrown away.
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.mocked(tauriCommands.hostedVaultRequest).mockRejectedValueOnce(
      new Error('This hosted vault belongs to a different Collab server.'),
    );
    const client = new HostedVaultClient(hostedVault);

    await expect(client.writeDocument('Notes/Test.md', '# Next', '3')).resolves.toEqual({
      version: '4',
      offlineQueued: true,
    });

    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      expect.objectContaining({
        kind: 'edit',
        fileId: 'file-1',
        relativePath: 'Notes/Test.md',
        baseManifestSequence: 8,
      }),
    );
  });

  it('write-through caches read documents into the offline replica', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ file: hostedDocument, content: '# Test' });
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: '2026-06-17T00:05:00Z',
      status: 'idle',
    });
    const client = new HostedVaultClient(hostedVault);

    await client.readDocument('Notes/Test.md');

    await vi.waitFor(() =>
      expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'file-1',
        '# Test',
      ),
    );
  });

  it('opens a matching cached hosted document before the network read completes', async () => {
    let resolveHostedRead:
      ((value: { file: typeof hostedDocument; content: string }) => void) | undefined;
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest());
    vi.mocked(tauriCommands.replicaCachedContentStatus).mockResolvedValue({
      present: true,
      matchesExpectedHash: true,
      actualSha256: 'hash-3',
      sizeBytes: 8,
    });
    vi.mocked(tauriCommands.replicaReadCachedDocument).mockResolvedValue('# Cached');
    vi.mocked(tauriCommands.hostedVaultRequest).mockImplementation((_serverUrl, _method, path) => {
      if (path.endsWith('/files/file-1')) {
        return new Promise((resolve) => {
          resolveHostedRead = resolve;
        }) as ReturnType<typeof tauriCommands.hostedVaultRequest>;
      }
      return Promise.resolve(mockHostedManifest()) as ReturnType<
        typeof tauriCommands.hostedVaultRequest
      >;
    });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readDocument('Notes/Test.md')).resolves.toEqual({
      relativePath: 'Notes/Test.md',
      content: '# Cached',
      version: '3',
      modifiedAt: Date.parse('2026-06-11T08:00:00Z'),
      source: 'cache',
      manifestSequence: 8,
      contentHash: 'hash-3',
    });

    expect(tauriCommands.replicaCachedContentStatus).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'file-1',
      'document',
      'hash-3',
    );
    expect(resolveHostedRead).not.toBeNull();

    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: '2026-06-17T00:05:00Z',
      status: 'idle',
    });
    if (!resolveHostedRead) throw new Error('Expected hosted document refresh to start.');
    resolveHostedRead({ file: hostedDocument, content: '# Fresh' });
    await vi.waitFor(() =>
      expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'file-1',
        '# Fresh',
      ),
    );
  });

  it('updates the cached manifest when a background hosted document refresh finds a newer revision', async () => {
    const freshDocument = {
      ...hostedDocument,
      updatedAt: '2026-06-11T09:00:00Z',
      currentRevision: {
        ...hostedDocument.currentRevision,
        id: 'revision-4',
        sequence: 4,
        contentHash: 'hash-4',
        sizeBytes: 7,
      },
    };
    let resolveHostedRead:
      ((value: { file: typeof freshDocument; content: string }) => void) | undefined;
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest());
    vi.mocked(tauriCommands.replicaCachedContentStatus).mockResolvedValue({
      present: true,
      matchesExpectedHash: true,
      actualSha256: 'hash-3',
      sizeBytes: 8,
    });
    vi.mocked(tauriCommands.replicaReadCachedDocument).mockResolvedValue('# Cached');
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: '2026-06-17T00:05:00Z',
      status: 'idle',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockImplementation((_serverUrl, _method, path) => {
      if (path.endsWith('/files/file-1')) {
        return new Promise((resolve) => {
          resolveHostedRead = resolve;
        }) as ReturnType<typeof tauriCommands.hostedVaultRequest>;
      }
      return Promise.resolve(mockHostedManifest()) as ReturnType<
        typeof tauriCommands.hostedVaultRequest
      >;
    });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readDocument('Notes/Test.md')).resolves.toMatchObject({
      content: '# Cached',
      version: '3',
    });

    if (!resolveHostedRead) throw new Error('Expected hosted document refresh to start.');
    resolveHostedRead({ file: freshDocument, content: '# Fresh' });

    await vi.waitFor(() =>
      expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'Hosted vault',
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              id: 'file-1',
              currentRevision: expect.objectContaining({ sequence: 4, contentHash: 'hash-4' }),
            }),
          ]),
        }),
        expect.objectContaining({ manifestSequence: 8, status: 'idle' }),
        'editor',
        ['vault.read', 'vault.offlineCopy'],
      ),
    );
  });

  it('ignores cached hosted documents that do not match the current revision hash', async () => {
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest());
    vi.mocked(tauriCommands.replicaCachedContentStatus).mockResolvedValue({
      present: true,
      matchesExpectedHash: false,
      actualSha256: 'old-hash',
      sizeBytes: 8,
    });
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ file: hostedDocument, content: '# Fresh' });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readDocument('Notes/Test.md')).resolves.toMatchObject({
      content: '# Fresh',
      version: '3',
    });

    expect(tauriCommands.replicaReadCachedDocument).not.toHaveBeenCalled();
  });

  it('does not build durable content caches before an offline copy is enabled', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ file: hostedDocument, content: '# Test' });
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: null,
      status: 'idle',
    });
    const client = new HostedVaultClient(hostedVault);

    await client.readDocument('Notes/Test.md');

    expect(tauriCommands.replicaCacheDocument).not.toHaveBeenCalled();
  });

  it('creates documents by resolving their hosted parent folder ID', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce(hostedDocument);
    const client = new HostedVaultClient(hostedVault);

    await client.createDocument('Notes/Test.md');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files',
      {
        parentId: 'folder-1',
        name: 'Test.md',
        kind: 'document',
        documentType: 'note',
        content: '',
      },
    );
  });

  it('creates hosted sheets with the structured sheet document type', async () => {
    const hostedSheet = {
      ...hostedDocument,
      id: 'sheet-1',
      name: 'Budget.sheet',
      relativePath: 'Notes/Budget.sheet',
      documentType: 'sheet' as const,
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce(hostedSheet);
    const client = new HostedVaultClient(hostedVault);

    await client.createDocument('Notes/Budget.sheet');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files',
      {
        parentId: 'folder-1',
        name: 'Budget.sheet',
        kind: 'document',
        documentType: 'sheet',
        content: '',
      },
    );
  });

  it('applies move-and-rename as sequential manifest-locked operations', async () => {
    const destination = { ...rootFolder, id: 'folder-2', name: 'Archive', relativePath: 'Archive' };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({
        ...mockHostedManifest(8),
        files: [rootFolder, destination, hostedDocument],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        ...mockHostedManifest(9),
        files: [
          rootFolder,
          destination,
          { ...hostedDocument, name: 'Renamed.md', relativePath: 'Notes/Renamed.md' },
        ],
      })
      .mockResolvedValueOnce({});
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const client = new HostedVaultClient(hostedVault);

    await client.renameMove('Notes/Test.md', 'Archive/Renamed.md');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/operations',
      expect.objectContaining({
        baseManifestSequence: 8,
        operationType: 'rename',
        name: 'Renamed.md',
      }),
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      4,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/operations',
      expect.objectContaining({
        baseManifestSequence: 9,
        operationType: 'move',
        parentId: 'folder-2',
      }),
    );
  });

  it('queues offline structural operations and updates the replica manifest optimistically', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'))
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'));
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const client = new HostedVaultClient(hostedVault);

    await client.renameMove('Notes/Test.md', 'Notes/Renamed.md');

    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted vault',
      expect.objectContaining({
        sequence: 8,
        files: expect.arrayContaining([
          expect.objectContaining({
            id: 'file-1',
            name: 'Renamed.md',
            relativePath: 'Notes/Renamed.md',
          }),
        ]),
      }),
      expect.objectContaining({ manifestSequence: 8, status: 'offline' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      expect.objectContaining({
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'rename',
        fileId: 'file-1',
        relativePath: 'Notes/Test.md',
        baseManifestSequence: 8,
        status: 'pending',
        payload: expect.objectContaining({
          clientOperationId: '11111111-1111-4111-8111-111111111111',
          operationType: 'rename',
          targetFileId: 'file-1',
          name: 'Renamed.md',
        }),
      }),
    );
  });

  it('queues offline document creation with a temporary replica entry', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'))
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'));
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest(8));
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    const client = new HostedVaultClient(hostedVault);

    await expect(client.createDocument('Notes/Draft.md')).resolves.toEqual(
      expect.objectContaining({
        relativePath: 'Notes/Draft.md',
        name: 'Draft.md',
        extension: 'md',
      }),
    );

    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'offline-file-11111111-1111-4111-8111-111111111111',
      '',
    );
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted vault',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            id: 'offline-file-11111111-1111-4111-8111-111111111111',
            parentId: 'folder-1',
            relativePath: 'Notes/Draft.md',
            state: 'active',
          }),
        ]),
      }),
      expect.objectContaining({ status: 'offline' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'create',
        fileId: 'offline-file-11111111-1111-4111-8111-111111111111',
        relativePath: 'Notes/Draft.md',
        payload: expect.objectContaining({
          parentId: 'folder-1',
          name: 'Draft.md',
          kind: 'document',
          tempFileId: 'offline-file-11111111-1111-4111-8111-111111111111',
        }),
      }),
    );
  });

  it('queues offline document edits and reads the cached document content', async () => {
    const optimisticManifest = {
      ...mockHostedManifest(8),
      files: mockHostedManifest(8).files.map((file) =>
        file.id === 'file-1'
          ? {
              ...file,
              currentRevision: {
                ...(file.currentRevision as object),
                sequence: 4,
                contentHash: 'offline',
              },
            }
          : file,
      ),
    };
    vi.mocked(tauriCommands.replicaReadManifest)
      .mockResolvedValueOnce(mockHostedManifest(8))
      .mockResolvedValueOnce(optimisticManifest);
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'))
      .mockRejectedValueOnce(new Error('NetworkError when attempting to fetch resource.'));
    vi.mocked(tauriCommands.replicaReadCachedDocument).mockResolvedValue('# Offline edit');
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444')
      .mockReturnValueOnce('55555555-5555-4555-8555-555555555555');
    const client = new HostedVaultClient(hostedVault);

    await expect(client.writeDocument('Notes/Test.md', '# Offline edit', '3')).resolves.toEqual({
      version: '4',
      offlineQueued: true,
    });
    await expect(client.readDocument('Notes/Test.md')).resolves.toMatchObject({
      relativePath: 'Notes/Test.md',
      content: '# Offline edit',
      version: '4',
      modifiedAt: Date.parse('2026-06-11T08:00:00Z'),
      source: 'optimistic-replica',
      contentHash: 'offline',
    });

    expect(tauriCommands.replicaCacheDocument).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'file-1',
      '# Offline edit',
    );
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted vault',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            id: 'file-1',
            currentRevision: expect.objectContaining({ sequence: 4, contentHash: 'offline' }),
          }),
        ]),
      }),
      expect.objectContaining({ status: 'offline' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      expect.objectContaining({
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'edit',
        fileId: 'file-1',
        payload: {
          targetFileId: 'file-1',
          expectedRevisionSequence: 3,
          content: '# Offline edit',
        },
      }),
    );
    expect(tauriCommands.replicaReadCachedDocument).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'file-1',
    );
  });

  it('reads hosted snapshots and authenticated assets without exposing access tokens', async () => {
    const snapshot = {
      id: 'snapshot-1',
      label: 'Checkpoint',
      revision: hostedDocument.currentRevision,
      createdByDisplayName: 'Alice',
      createdAt: '2026-06-11T09:00:00Z',
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValueOnce({ revision: hostedDocument.currentRevision, content: '# Snapshot' })
      .mockResolvedValueOnce(mockHostedManifest());
    vi.mocked(tauriCommands.hostedVaultAssetDataUrl).mockResolvedValue(
      'data:text/plain;base64,IyBUZXN0',
    );
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readSnapshot('Notes/Test.md', 'snapshot-1')).resolves.toBe('# Snapshot');
    await expect(client.readAssetDataUrl('Notes/Test.md')).resolves.toBe(
      'data:text/plain;base64,IyBUZXN0',
    );
    expect(tauriCommands.hostedVaultAssetDataUrl).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'file-1',
    );
  });

  it('serves cached asset bytes when the asset fetch fails offline', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValueOnce(mockHostedManifest());
    vi.mocked(tauriCommands.hostedVaultAssetDataUrl).mockRejectedValue(
      new Error('NetworkError when attempting to fetch resource.'),
    );
    vi.mocked(tauriCommands.replicaReadCachedAsset).mockResolvedValue('UERG');
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readAssetDataUrl('doc.pdf')).resolves.toBe(
      'data:application/pdf;base64,UERG',
    );
    expect(tauriCommands.replicaReadCachedAsset).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'pdf-1',
    );
  });

  it('opens a matching cached hosted asset before downloading it', async () => {
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue(mockHostedManifest());
    vi.mocked(tauriCommands.replicaCachedContentStatus).mockResolvedValue({
      present: true,
      matchesExpectedHash: true,
      actualSha256: 'pdf-hash',
      sizeBytes: 4,
    });
    vi.mocked(tauriCommands.replicaReadCachedAsset).mockResolvedValue('UERG');
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readAssetDataUrl('doc.pdf')).resolves.toBe(
      'data:application/pdf;base64,UERG',
    );

    expect(tauriCommands.hostedVaultAssetDataUrl).not.toHaveBeenCalled();
    expect(tauriCommands.replicaCachedContentStatus).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'pdf-1',
      'asset',
      'pdf-hash',
    );
  });

  it('rethrows when an asset is offline and not cached', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValueOnce(mockHostedManifest());
    vi.mocked(tauriCommands.hostedVaultAssetDataUrl).mockRejectedValue(
      new Error('NetworkError when attempting to fetch resource.'),
    );
    vi.mocked(tauriCommands.replicaReadCachedAsset).mockResolvedValue(null);
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readAssetDataUrl('doc.pdf')).rejects.toThrow(/NetworkError/);
  });

  it('maps structural previews, root trash entries, and hosted search results', async () => {
    const trashedFolder = {
      ...rootFolder,
      state: 'trashed' as const,
      updatedAt: '2026-06-11T10:00:00Z',
    };
    const trashedChild = {
      ...hostedDocument,
      state: 'trashed' as const,
      updatedAt: '2026-06-11T10:00:00Z',
    };
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({
        oldRelativePath: 'Notes/Test.md',
        newRelativePath: 'Notes/Renamed.md',
        itemKind: 'document',
        nestedItemCount: 0,
        affectedDocuments: [{ relativePath: 'Index.md' }],
        blockedReason: null,
      })
      .mockResolvedValueOnce({
        ...mockHostedManifest(),
        files: [trashedFolder, trashedChild],
      })
      .mockResolvedValueOnce([
        { relativePath: 'Notes/Test.md', title: 'Test', excerpt: 'match', rank: 0.75 },
      ]);
    const client = new HostedVaultClient(hostedVault);

    await expect(client.previewRenameMove('Notes/Test.md', 'Notes/Renamed.md')).resolves.toEqual({
      oldRelativePath: 'Notes/Test.md',
      newRelativePath: 'Notes/Renamed.md',
      itemKind: 'file',
      operation: 'rename',
      nestedItemCount: 0,
      affectedReferencePaths: ['Index.md'],
      blockedReason: undefined,
    });
    await expect(client.listTrash()).resolves.toEqual([
      expect.objectContaining({
        id: 'folder-1',
        originalRelativePath: 'Notes',
        itemKind: 'folder',
      }),
    ]);
    await expect(client.search('hello world')).resolves.toEqual([
      {
        relativePath: 'Notes/Test.md',
        title: 'Test',
        excerpt: 'match',
        score: 0.75,
        matchType: 'hosted',
      },
    ]);
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/search?q=hello%20world',
      undefined,
    );
  });

  it('restores and purges hosted trash entries through manifest-locked operations', async () => {
    const trashedDocument = { ...hostedDocument, state: 'trashed' as const };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce({ ...mockHostedManifest(8), files: [rootFolder, trashedDocument] })
      .mockResolvedValueOnce({ ...mockHostedManifest(8), files: [rootFolder, trashedDocument] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ...mockHostedManifest(9), files: [rootFolder, trashedDocument] })
      .mockResolvedValueOnce({ ...mockHostedManifest(9), files: [rootFolder, trashedDocument] })
      .mockResolvedValueOnce({});
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const client = new HostedVaultClient(hostedVault);

    await client.restoreTrash('file-1');
    await client.purgeTrash('file-1', true);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      3,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/operations',
      expect.objectContaining({
        baseManifestSequence: 8,
        operationType: 'restore',
        targetFileId: 'file-1',
      }),
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      6,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/operations',
      expect.objectContaining({
        baseManifestSequence: 9,
        operationType: 'purge',
        targetFileId: 'file-1',
        removeReferences: true,
      }),
    );
  });

  it('labels the current hosted revision when creating a snapshot without sending content', async () => {
    const snapshot = {
      id: 'snapshot-9',
      label: 'Checkpoint',
      revision: hostedDocument.currentRevision,
      createdByDisplayName: 'Alice',
      createdAt: '2026-06-11T09:00:00Z',
    };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce(snapshot);
    const client = new HostedVaultClient(hostedVault);

    await expect(
      client.createSnapshot('Notes/Test.md', 'ignored body', 'ignored', 'ignored', 'Checkpoint'),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'snapshot-9',
        label: 'Checkpoint',
        hash: 'hash-3',
        authorName: 'Alice',
      }),
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files/file-1/snapshots',
      { revisionId: 'revision-3', label: 'Checkpoint' },
    );
  });

  it('restores hosted snapshots and keeps destructive history immutable', async () => {
    const restoredDocument = {
      ...hostedDocument,
      currentRevision: { ...hostedDocument.currentRevision, id: 'revision-4', sequence: 4 },
    };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ file: restoredDocument, content: '# Restored' });
    const client = new HostedVaultClient(hostedVault);

    await expect(
      client.restoreSnapshot('Notes/Test.md', 'snapshot-1', 'ignored', 'ignored'),
    ).resolves.toEqual({
      version: '4',
    });
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/files/file-1/snapshots/snapshot-1/restore',
      { expectedRevisionSequence: 3 },
    );
    await expect(client.deleteSnapshot('Notes/Test.md', 'snapshot-1')).rejects.toThrow('immutable');
    await expect(client.clearSnapshotHistory('Notes/Test.md')).rejects.toThrow('immutable');
  });

  it('loads hosted file references through stable file IDs', async () => {
    const reference = {
      sourceFileId: 'source-1',
      sourceRelativePath: 'Index.md',
      sourceDocumentType: 'note',
      referenceKind: 'note-wikilink',
      referencedFileId: 'file-1',
      referencedRelativePath: 'Notes/Test.md',
      displayLabel: 'Test',
      context: '[[Test]]',
    };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce([reference]);
    const client = new HostedVaultClient(hostedVault);

    await expect(client.listReferences('Notes/Test.md')).resolves.toEqual([reference]);
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/files/file-1/references',
      undefined,
    );
  });

  it('uploads an external desktop asset into an existing hosted folder with a verified digest', async () => {
    const pictures = {
      ...rootFolder,
      id: 'folder-pics',
      name: 'Pictures',
      relativePath: 'Pictures',
    };
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name: 'diagram.png',
      mediaType: 'image/png',
      contentBase64: 'aW1n',
      expectedHash: 'abc123',
    });
    vi.mocked(tauriCommands.hostedVaultUploadFile).mockResolvedValue({
      ...hostedDocument,
      id: 'asset-1',
      kind: 'asset',
      documentType: null,
      name: 'diagram.png',
      relativePath: 'Pictures/diagram.png',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValueOnce({
      ...mockHostedManifest(),
      files: [rootFolder, pictures, hostedDocument],
    });
    vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
      manifestSequence: 8,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      offlineAvailableAt: '2026-06-17T00:05:00Z',
      status: 'idle',
    });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.runtime.externalAssetImport!.import('/tmp/diagram.png')).resolves.toBe(
      'Pictures/diagram.png',
    );
    expect(tauriCommands.hostedVaultUploadFile).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'folder-pics',
      '/tmp/diagram.png',
    );
    await vi.waitFor(() =>
      expect(tauriCommands.replicaCacheAsset).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'asset-1',
        'aW1n',
      ),
    );
    expect(tauriCommands.readFileForUpload).toHaveBeenCalledWith('/tmp/diagram.png');
  });

  it('queues interrupted hosted asset uploads with cached bytes for retry', async () => {
    const pictures = {
      ...rootFolder,
      id: 'folder-pics',
      name: 'Pictures',
      relativePath: 'Pictures',
    };
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name: 'diagram.png',
      mediaType: 'image/png',
      contentBase64: 'aW1n',
      expectedHash: 'abc123',
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValueOnce({
      ...mockHostedManifest(),
      files: [rootFolder, pictures, hostedDocument],
    });
    vi.mocked(tauriCommands.hostedVaultUploadFile).mockRejectedValue(
      new Error('NetworkError when attempting to fetch resource.'),
    );
    vi.mocked(tauriCommands.replicaReadManifest).mockResolvedValue({
      ...mockHostedManifest(),
      files: [rootFolder, pictures, hostedDocument],
    });
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    const client = new HostedVaultClient(hostedVault);

    await expect(client.runtime.externalAssetImport!.import('/tmp/diagram.png')).resolves.toBe(
      'Pictures/diagram.png',
    );

    expect(tauriCommands.replicaCacheAsset).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'offline-asset-11111111-1111-4111-8111-111111111111',
      'aW1n',
    );
    expect(tauriCommands.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted vault',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            id: 'offline-asset-11111111-1111-4111-8111-111111111111',
            parentId: 'folder-pics',
            relativePath: 'Pictures/diagram.png',
            kind: 'asset',
            currentRevision: expect.objectContaining({ contentHash: 'abc123', sizeBytes: 3 }),
          }),
        ]),
      }),
      expect.objectContaining({ status: 'offline' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
    expect(tauriCommands.replicaEnqueueOperation).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'assetUpload',
        fileId: 'offline-asset-11111111-1111-4111-8111-111111111111',
        relativePath: 'Pictures/diagram.png',
        payload: {
          parentId: 'folder-pics',
          name: 'diagram.png',
          mediaType: 'image/png',
          expectedHash: 'abc123',
          assetCacheId: 'offline-asset-11111111-1111-4111-8111-111111111111',
        },
      }),
    );
  });

  it('manages hosted members and resolves the user directory off the vault gateway', async () => {
    const member = {
      userId: 'user-9',
      username: 'alice',
      displayName: 'Alice',
      role: 'editor' as const,
      owner: false,
      createdAt: '2026-06-11T08:00:00Z',
    };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce([member])
      .mockResolvedValueOnce(member)
      .mockResolvedValueOnce({ ...member, role: 'admin' })
      .mockResolvedValueOnce(null);
    vi.mocked(tauriCommands.hostedUserDirectory).mockResolvedValue([
      { userId: 'user-9', username: 'alice', displayName: 'Alice' },
    ]);
    const members = new HostedVaultClient({
      ...hostedVault,
      capabilities: ['vault.manageMembers'],
    }).runtime.members!;

    await expect(members.list()).resolves.toEqual([member]);
    await expect(members.searchDirectory('al')).resolves.toEqual([
      { userId: 'user-9', username: 'alice', displayName: 'Alice' },
    ]);
    await members.add('user-9', 'editor');
    await members.updateRole('user-9', 'admin');
    await members.remove('user-9');

    expect(tauriCommands.hostedUserDirectory).toHaveBeenCalledWith(
      'https://collab.example.test',
      'al',
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/members',
      undefined,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'POST',
      '/api/v1/vaults/hosted-vault/members',
      { userId: 'user-9', role: 'editor' },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      3,
      'https://collab.example.test',
      'PATCH',
      '/api/v1/vaults/hosted-vault/members/user-9',
      { role: 'admin' },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      4,
      'https://collab.example.test',
      'DELETE',
      '/api/v1/vaults/hosted-vault/members/user-9',
      undefined,
    );
  });

  it('fails closed when member mutations are missing manage-members capability', async () => {
    const members = new HostedVaultClient({ ...hostedVault, capabilities: [] }).runtime.members!;

    expect(() => members.searchDirectory('al')).toThrow('permission');
    expect(() => members.add('user-9', 'editor')).toThrow('permission');
    expect(() => members.updateRole('user-9', 'admin')).toThrow('permission');
    expect(() => members.remove('user-9')).toThrow('permission');
    expect(tauriCommands.hostedUserDirectory).not.toHaveBeenCalled();
    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalled();
  });

  it('edits fine-grained permissions through the member gateway', async () => {
    const member = {
      userId: 'user-9',
      username: 'alice',
      displayName: 'Alice',
      role: 'editor' as const,
      owner: false,
      createdAt: '2026-06-11T08:00:00Z',
    };
    vi.mocked(tauriCommands.hostedVaultRequest).mockReset();
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue(member);
    const members = new HostedVaultClient({
      ...hostedVault,
      capabilities: ['vault.managePermissions'],
    }).runtime.members!;

    await members.listTemplates();
    await members.setCapabilities('user-9', ['vault.read', 'note.edit']);
    await members.setTemplate('user-9', 'tpl-1');
    await members.resetToRoleDefault('user-9');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/templates',
      undefined,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example.test',
      'PATCH',
      '/api/v1/vaults/hosted-vault/members/user-9',
      { capabilities: ['vault.read', 'note.edit'] },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      3,
      'https://collab.example.test',
      'PATCH',
      '/api/v1/vaults/hosted-vault/members/user-9',
      { templateId: 'tpl-1' },
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      4,
      'https://collab.example.test',
      'PATCH',
      '/api/v1/vaults/hosted-vault/members/user-9',
      { resetToRoleDefault: true },
    );
  });

  it('fails closed when permission edits are missing manage-permissions capability', async () => {
    const members = new HostedVaultClient({
      ...hostedVault,
      capabilities: ['vault.manageMembers'],
    }).runtime.members!;

    expect(() => members.listTemplates()).toThrow('permission');
    expect(() => members.setCapabilities('user-9', ['vault.read'])).toThrow('permission');
    expect(() => members.setTemplate('user-9', 'tpl-1')).toThrow('permission');
    expect(() => members.resetToRoleDefault('user-9')).toThrow('permission');
    expect(tauriCommands.hostedVaultRequest).not.toHaveBeenCalled();
  });
});

describe('vault client runtime boundary', () => {
  it('creates the correct client from persisted vault metadata', () => {
    expect(createVaultClient(vault)).toBeInstanceOf(LocalVaultClient);
    expect(createVaultClient({ ...vault, kind: undefined })).toBeInstanceOf(LocalVaultClient);
    expect(createVaultClient(hostedVault)).toBeInstanceOf(HostedVaultClient);
  });

  it('rejects unsupported runtime capabilities instead of falling through to Tauri', () => {
    const client = new HostedVaultClient(hostedVault);
    expect(() => requireRuntimeCapability(client, 'encryption')).toThrow(
      'The encryption capability is not available for hosted vaults.',
    );
    expect(() => requireRuntimeCapability(client, 'archiveExport')).toThrow(
      'The archiveExport capability is not available for hosted vaults.',
    );
  });
});

// The shared VaultClient surface every consumer relies on. Both adapters must
// implement it identically so callers can switch between local and hosted
// vaults without per-method branching.
const VAULT_CLIENT_METHODS = [
  'listFiles',
  'readDocument',
  'writeDocument',
  'createDocument',
  'createFolder',
  'previewRenameMove',
  'renameMove',
  'moveToTrash',
  'deletePermanently',
  'listReferences',
  'listTrash',
  'restoreTrash',
  'purgeTrash',
  'purgeAllTrash',
  'search',
  'createSnapshot',
  'listSnapshots',
  'readSnapshot',
  'restoreSnapshot',
  'deleteSnapshot',
  'clearSnapshotHistory',
  'readAssetDataUrl',
] as const;

const CAPABILITY_KEYS = [
  'nativeFilesystem',
  'filesystemWatch',
  'offlineAccess',
  'encryption',
  'hostedMemberships',
  'authenticatedAssets',
  'destructiveSnapshotHistory',
] as const;

describe('VaultClient adapter contract parity', () => {
  const local = new LocalVaultClient(vault);
  const hosted = new HostedVaultClient(hostedVault);

  it.each([
    ['local', local],
    ['hosted', hosted],
  ])('%s adapter implements every VaultClient method', (_label, client) => {
    for (const method of VAULT_CLIENT_METHODS) {
      expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it.each([
    ['local', local],
    ['hosted', hosted],
  ])('%s adapter reports a stable kind, id, and full capability matrix', (label, client) => {
    expect(client.kind).toBe(label === 'local' ? 'local' : 'hosted');
    expect(client.id).toBe(label === 'local' ? vault.id : hostedVault.id);
    for (const key of CAPABILITY_KEYS) {
      expect(typeof client.capabilities[key]).toBe('boolean');
    }
  });

  it('exposes mutually exclusive native vs hosted runtime capabilities', () => {
    // Native-only operations belong to local vaults; hosted membership belongs to hosted vaults.
    expect(local.runtime.watch).toBeDefined();
    expect(local.runtime.encryption).toBeDefined();
    expect(local.runtime.archiveExport).toBeDefined();
    expect(local.runtime.members).toBeUndefined();
    expect(local.runtime.logicComponents).toBeDefined();

    expect(hosted.runtime.watch).toBeUndefined();
    expect(hosted.runtime.encryption).toBeUndefined();
    expect(hosted.runtime.members).toBeDefined();
    expect(hosted.runtime.logicComponents).toBeDefined();

    // External asset import is available in both modes.
    expect(local.runtime.externalAssetImport).toBeDefined();
    expect(hosted.runtime.externalAssetImport).toBeDefined();
  });

  it('exposes hosted ZIP export only to vault admins', () => {
    // The editor fixture is not an admin, so server-authorized export is hidden.
    expect(hosted.runtime.archiveExport).toBeUndefined();
    const adminHosted = new HostedVaultClient({ ...hostedVault, role: 'admin' });
    expect(adminHosted.runtime.archiveExport).toBeDefined();
  });

  it('keeps the published capability constants aligned with adapter instances', () => {
    expect(local.capabilities).toEqual(LOCAL_VAULT_CAPABILITIES);
    expect(hosted.capabilities).toEqual(HOSTED_VAULT_CAPABILITIES);
  });
});

describe('PDF annotations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes local PDF annotations through the filesystem sidecar with no version', async () => {
    const sidecar = {
      bookmarks: [],
      highlights: [],
      textAnnotations: [],
      pageComments: [{ id: 'k', page: 1, content: 'hi', createdAt: 1, updatedAt: 1 }],
      viewerState: { lastPage: 2 },
    };
    vi.mocked(tauriCommands.readPdfSidecarState).mockResolvedValue(sidecar);
    const client = new LocalVaultClient(vault);

    await expect(client.readPdfAnnotations('Docs/spec.pdf')).resolves.toEqual({
      state: sidecar,
      version: null,
    });
    expect(tauriCommands.readPdfSidecarState).toHaveBeenCalledWith('/vault', 'Docs/spec.pdf');

    await client.writePdfAnnotations('Docs/spec.pdf', sidecar, null);
    expect(tauriCommands.writePdfSidecarState).toHaveBeenCalledWith(
      '/vault',
      'Docs/spec.pdf',
      sidecar,
    );
  });

  it('reads hosted PDF annotations from the endpoint and normalizes the state', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ state: { pageComments: [{ id: 'k' }] }, sequence: 3 });
    const client = new HostedVaultClient(hostedVault);

    await expect(client.readPdfAnnotations('doc.pdf')).resolves.toEqual({
      state: {
        bookmarks: [],
        highlights: [],
        textAnnotations: [],
        pageComments: [{ id: 'k' }],
        viewerState: null,
      },
      version: 3,
    });
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/hosted-vault/files/pdf-1/pdf-annotations',
      undefined,
    );
  });

  it('writes hosted PDF annotations with the optimistic sequence and drops viewer state', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest)
      .mockResolvedValueOnce(mockHostedManifest())
      .mockResolvedValueOnce({ state: { bookmarks: [{ id: 'b' }] }, sequence: 4 });
    const client = new HostedVaultClient(hostedVault);

    const state = {
      bookmarks: [{ id: 'b', page: 1, createdAt: 1, updatedAt: 1 }],
      highlights: [],
      textAnnotations: [],
      pageComments: [],
      viewerState: { lastPage: 5 },
    };
    const result = await client.writePdfAnnotations('doc.pdf', state, 3);
    expect(result.version).toBe(4);
    expect(tauriCommands.hostedVaultRequest).toHaveBeenLastCalledWith(
      'https://collab.example.test',
      'PUT',
      '/api/v1/vaults/hosted-vault/files/pdf-1/pdf-annotations',
      {
        expectedSequence: 3,
        // viewerState is intentionally excluded from the shared server state.
        state: {
          bookmarks: [{ id: 'b', page: 1, createdAt: 1, updatedAt: 1 }],
          highlights: [],
          textAnnotations: [],
          pageComments: [],
        },
      },
    );
  });
});
