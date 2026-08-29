import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedVaultMeta, HostedVaultSummary } from '../types/vault';

import { sortFileTreeAlphabetically, useVaultStore } from './vaultStore';

const tauriCommandsMock = vi.hoisted(() => ({
  unwatchVault: vi.fn(),
  openVault: vi.fn(),
  listVaultFiles: vi.fn(),
  watchVault: vi.fn(),
  unlockVault: vi.fn(),
  getRecentVaults: vi.fn(),
  removeRecentVault: vi.fn(),
  isFlatpak: vi.fn(),
  showOpenVaultDialog: vi.fn(),
  hostedVaultRequest: vi.fn(),
  hostedVaultAssetDataUrl: vi.fn(),
  replicaSeed: vi.fn(),
  replicaReadManifest: vi.fn(),
  replicaReadSyncState: vi.fn(),
  replicaWriteSyncState: vi.fn(),
  replicaListPendingOperations: vi.fn(),
  replicaCachedContentStatus: vi.fn(),
  replicaCacheDocument: vi.fn(),
  replicaCacheAsset: vi.fn(),
  replicaCleanup: vi.fn().mockResolvedValue({ removedFiles: 0, freedBytes: 0, remainingBytes: 0 }),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: tauriCommandsMock,
}));

describe('vaultStore Flatpak reopen fallback', () => {
  const initialState = useVaultStore.getState();

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useVaultStore.setState({
      ...initialState,
      vault: null,
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      lastOpenedVaultPath: null,
      isLoading: false,
    });

    tauriCommandsMock.unwatchVault.mockResolvedValue(undefined);
    tauriCommandsMock.listVaultFiles.mockResolvedValue([]);
    tauriCommandsMock.watchVault.mockResolvedValue(undefined);
    tauriCommandsMock.unlockVault.mockResolvedValue(undefined);
    tauriCommandsMock.getRecentVaults.mockResolvedValue([]);
    tauriCommandsMock.removeRecentVault.mockResolvedValue(undefined);
    tauriCommandsMock.replicaReadManifest.mockResolvedValue(null);
    tauriCommandsMock.replicaReadSyncState.mockResolvedValue({
      manifestSequence: 0,
      lastSyncedAt: null,
      offlineAvailableAt: null,
      status: 'idle',
    });
    tauriCommandsMock.replicaWriteSyncState.mockResolvedValue(undefined);
    tauriCommandsMock.replicaListPendingOperations.mockResolvedValue([]);
    tauriCommandsMock.replicaCachedContentStatus.mockResolvedValue({
      present: false,
      matchesExpectedHash: false,
      actualSha256: null,
      sizeBytes: null,
    });
    tauriCommandsMock.replicaCacheDocument.mockResolvedValue(undefined);
    tauriCommandsMock.replicaCacheAsset.mockResolvedValue(undefined);
    tauriCommandsMock.hostedVaultAssetDataUrl.mockResolvedValue('data:image/png;base64,YXNzZXQ=');
  });

  it('reauthorizes Flatpak recents when direct reopen loses access', async () => {
    tauriCommandsMock.openVault
      .mockRejectedValueOnce(
        new Error("Cannot open vault path '/old/vault': No such file or directory (os error 2)"),
      )
      .mockResolvedValueOnce({
        id: 'vault-1',
        name: 'Vault',
        path: '/reauthorized/vault',
        lastOpened: 1,
        isEncrypted: false,
      });
    tauriCommandsMock.isFlatpak.mockResolvedValue(true);
    tauriCommandsMock.showOpenVaultDialog.mockResolvedValue('/reauthorized/vault');

    await useVaultStore.getState().openVault('/old/vault');

    expect(tauriCommandsMock.openVault).toHaveBeenNthCalledWith(1, '/old/vault');
    expect(tauriCommandsMock.showOpenVaultDialog).toHaveBeenCalledTimes(1);
    expect(tauriCommandsMock.openVault).toHaveBeenNthCalledWith(2, '/reauthorized/vault');
    expect(useVaultStore.getState().vault?.path).toBe('/reauthorized/vault');
    expect(useVaultStore.getState().lastOpenedVaultPath).toBe('/reauthorized/vault');
    expect(useVaultStore.getState().isLoading).toBe(false);
  });

  it('sorts file trees alphabetically and recursively for display', () => {
    const sorted = sortFileTreeAlphabetically([
      {
        relativePath: 'Beta',
        name: 'Beta',
        extension: '',
        modifiedAt: 1,
        size: 0,
        isFolder: true,
      },
      {
        relativePath: 'zeta.md',
        name: 'zeta.md',
        extension: 'md',
        modifiedAt: 1,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'Ordner',
        name: 'Ordner',
        extension: '',
        modifiedAt: 1,
        size: 0,
        isFolder: true,
        children: [
          {
            relativePath: 'Ordner/zulu.md',
            name: 'zulu.md',
            extension: 'md',
            modifiedAt: 1,
            size: 1,
            isFolder: false,
          },
          {
            relativePath: 'Ordner/Ähre.md',
            name: 'Ähre.md',
            extension: 'md',
            modifiedAt: 1,
            size: 1,
            isFolder: false,
          },
          {
            relativePath: 'Ordner/alpha.md',
            name: 'alpha.md',
            extension: 'md',
            modifiedAt: 1,
            size: 1,
            isFolder: false,
          },
        ],
      },
      {
        relativePath: 'Alpha.md',
        name: 'Alpha.md',
        extension: 'md',
        modifiedAt: 1,
        size: 1,
        isFolder: false,
      },
      {
        relativePath: 'äther.md',
        name: 'äther.md',
        extension: 'md',
        modifiedAt: 1,
        size: 1,
        isFolder: false,
      },
    ]);

    expect(sorted.map((node) => node.name)).toEqual([
      'Beta',
      'Ordner',
      'Alpha.md',
      'äther.md',
      'zeta.md',
    ]);
    expect(sorted[1]?.children?.map((node) => node.name)).toEqual([
      'Ähre.md',
      'alpha.md',
      'zulu.md',
    ]);
  });

  it('refreshes hosted file trees without starting a local filesystem watcher', async () => {
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: 1,
        isEncrypted: false,
      },
    });
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 1,
      files: [
        {
          id: 'file-1',
          parentId: null,
          name: 'Hosted.md',
          relativePath: 'Hosted.md',
          kind: 'document',
          documentType: 'note',
          state: 'active',
          currentRevision: null,
          createdAt: '2026-06-11T08:00:00Z',
          updatedAt: '2026-06-11T08:00:00Z',
        },
      ],
    };
    tauriCommandsMock.replicaReadManifest.mockResolvedValue(manifest);
    tauriCommandsMock.replicaReadSyncState.mockResolvedValue({
      manifestSequence: 1,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    tauriCommandsMock.hostedVaultRequest.mockResolvedValue({
      vaultId: 'hosted-vault',
      baseSequence: 1,
      sequence: 1,
      changedFiles: [],
    });

    await useVaultStore.getState().refreshFileTree();
    expect(useVaultStore.getState().fileTree).toEqual([
      expect.objectContaining({ relativePath: 'Hosted.md' }),
    ]);

    useVaultStore.getState().closeVault();

    expect(tauriCommandsMock.watchVault).not.toHaveBeenCalled();
    expect(tauriCommandsMock.unwatchVault).not.toHaveBeenCalled();
  });

  it('opens hosted vault metadata through HostedVaultClient without local IPC', async () => {
    const hosted = {
      kind: 'hosted' as const,
      id: 'hosted-vault',
      hostedVaultId: 'hosted-vault',
      serverUrl: 'https://collab.example.test',
      role: 'editor' as const,
      name: 'Hosted Vault',
      path: 'hosted://hosted-vault',
      lastOpened: 1,
      isEncrypted: false,
    };
    const manifest = { vaultId: 'hosted-vault', sequence: 1, files: [] };
    tauriCommandsMock.replicaReadManifest.mockResolvedValue(manifest);
    tauriCommandsMock.replicaReadSyncState.mockResolvedValue({
      manifestSequence: 1,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    tauriCommandsMock.hostedVaultRequest.mockResolvedValue({
      vaultId: 'hosted-vault',
      baseSequence: 1,
      sequence: 1,
      changedFiles: [],
    });

    await useVaultStore.getState().openHostedVault(hosted);

    expect(useVaultStore.getState().vault).toEqual(hosted);
    expect(useVaultStore.getState().lastOpenedVaultPath).toBeNull();
    expect(tauriCommandsMock.replicaReadManifest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
    );
    expect(tauriCommandsMock.openVault).not.toHaveBeenCalled();
    expect(tauriCommandsMock.watchVault).not.toHaveBeenCalled();
  });

  const hostedVault: HostedVaultMeta = {
    kind: 'hosted',
    id: 'hosted-vault',
    hostedVaultId: 'hosted-vault',
    serverUrl: 'https://collab.example.test',
    role: 'editor',
    name: 'Hosted Vault',
    path: 'hosted://hosted-vault',
    lastOpened: 1,
    isEncrypted: false,
    capabilities: ['vault.read', 'vault.offlineCopy'],
    requireOfflineCopy: false,
  };

  const hostedSummary: HostedVaultSummary = {
    id: 'hosted-vault',
    name: 'Hosted Vault',
    ownerUserId: 'owner-1',
    ownerDisplayName: 'Owner',
    role: 'editor',
    status: 'active',
    manifestSequence: 4,
    members: 2,
    storageBytes: 100,
    createdAt: '1970-01-01T00:00:01.000Z',
    updatedAt: '1970-01-01T00:00:00.001Z',
    capabilities: ['vault.read', 'vault.offlineCopy'],
    requireOfflineCopy: false,
  };

  it('does not replace open hosted vault metadata when refresh data is unchanged', () => {
    useVaultStore.setState({ vault: hostedVault });
    const before = useVaultStore.getState().vault;

    useVaultStore.getState().refreshHostedVaultMetadata('https://collab.example.test', [
      {
        ...hostedSummary,
        updatedAt: '2026-07-06T08:00:00.000Z',
      },
    ]);

    expect(useVaultStore.getState().vault).toBe(before);
  });

  it('updates open hosted vault metadata when access data changes', () => {
    useVaultStore.setState({ vault: hostedVault });

    useVaultStore.getState().refreshHostedVaultMetadata('https://collab.example.test', [
      {
        ...hostedSummary,
        role: 'viewer',
        capabilities: ['vault.read'],
      },
    ]);

    expect(useVaultStore.getState().vault).toMatchObject({
      role: 'viewer',
      capabilities: ['vault.read'],
    });
  });

  it('seeds the offline replica from the manifest when opening a hosted vault', async () => {
    const manifest = { vaultId: 'hosted-vault', sequence: 4, files: [] };
    tauriCommandsMock.hostedVaultRequest.mockImplementation((_url, _method, path) =>
      Promise.resolve(path.endsWith('/manifest') ? manifest : []),
    );
    tauriCommandsMock.replicaSeed.mockResolvedValue(undefined);

    await useVaultStore.getState().openHostedVault(hostedVault);

    await vi.waitFor(() => expect(tauriCommandsMock.replicaSeed).toHaveBeenCalled());
    expect(tauriCommandsMock.replicaSeed).toHaveBeenCalledWith(
      'https://collab.example.test',
      'hosted-vault',
      'Hosted Vault',
      manifest,
      expect.objectContaining({ manifestSequence: 4, status: 'idle' }),
      'editor',
      ['vault.read', 'vault.offlineCopy'],
    );
  });

  it('creates a full offline copy when the client preference is enabled', async () => {
    localStorage.setItem('collab-hosted-always-create-offline-copy', 'true');
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 4,
      files: [
        {
          id: 'note-1',
          parentId: null,
          name: 'Hosted.md',
          relativePath: 'Hosted.md',
          kind: 'document',
          documentType: 'note',
          state: 'active',
          currentRevision: null,
          createdAt: '2026-06-11T08:00:00Z',
          updatedAt: '2026-06-11T08:00:00Z',
        },
      ],
    };
    tauriCommandsMock.hostedVaultRequest.mockImplementation((_url, _method, path) => {
      if (path.endsWith('/manifest')) return Promise.resolve(manifest);
      if (path.endsWith('/files/note-1')) return Promise.resolve({ content: '# Hosted' });
      return Promise.resolve({
        vaultId: 'hosted-vault',
        baseSequence: 0,
        sequence: 4,
        changedFiles: [],
      });
    });
    tauriCommandsMock.replicaReadManifest.mockResolvedValueOnce(null).mockResolvedValue(manifest);
    tauriCommandsMock.replicaSeed.mockResolvedValue(undefined);

    await useVaultStore.getState().openHostedVault(hostedVault);

    await vi.waitFor(() =>
      expect(tauriCommandsMock.replicaCacheDocument).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'note-1',
        '# Hosted',
      ),
    );
  });

  it('does not create a full offline copy when the user lacks the offline-copy capability', async () => {
    localStorage.setItem('collab-hosted-always-create-offline-copy', 'true');
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 4,
      files: [
        {
          id: 'note-1',
          parentId: null,
          name: 'Hosted.md',
          relativePath: 'Hosted.md',
          kind: 'document',
          documentType: 'note',
          state: 'active',
          currentRevision: null,
          createdAt: '2026-06-11T08:00:00Z',
          updatedAt: '2026-06-11T08:00:00Z',
        },
      ],
    };
    tauriCommandsMock.hostedVaultRequest.mockImplementation((_url, _method, path) => {
      if (path.endsWith('/manifest')) return Promise.resolve(manifest);
      if (path.endsWith('/files/note-1')) return Promise.resolve({ content: '# Hosted' });
      return Promise.resolve({
        vaultId: 'hosted-vault',
        baseSequence: 0,
        sequence: 4,
        changedFiles: [],
      });
    });
    tauriCommandsMock.replicaSeed.mockResolvedValue(undefined);

    await useVaultStore.getState().openHostedVault({
      ...hostedVault,
      capabilities: ['vault.read'],
      requireOfflineCopy: true,
    });

    await vi.waitFor(() => expect(tauriCommandsMock.replicaSeed).toHaveBeenCalled());
    await Promise.resolve();
    expect(tauriCommandsMock.replicaCacheDocument).not.toHaveBeenCalled();
    expect(tauriCommandsMock.replicaCacheAsset).not.toHaveBeenCalled();
  });

  it('creates a full offline copy when the server requires one for the vault', async () => {
    const manifest = {
      vaultId: 'hosted-vault',
      sequence: 4,
      files: [
        {
          id: 'asset-1',
          parentId: null,
          name: 'Diagram.png',
          relativePath: 'Diagram.png',
          kind: 'asset',
          documentType: null,
          state: 'active',
          currentRevision: null,
          createdAt: '2026-06-11T08:00:00Z',
          updatedAt: '2026-06-11T08:00:00Z',
        },
      ],
    };
    tauriCommandsMock.hostedVaultRequest.mockImplementation((_url, _method, path) => {
      if (path.endsWith('/manifest')) return Promise.resolve(manifest);
      return Promise.resolve({
        vaultId: 'hosted-vault',
        baseSequence: 0,
        sequence: 4,
        changedFiles: [],
      });
    });
    tauriCommandsMock.replicaReadManifest.mockResolvedValueOnce(null).mockResolvedValue(manifest);
    tauriCommandsMock.replicaSeed.mockResolvedValue(undefined);

    await useVaultStore.getState().openHostedVault({ ...hostedVault, requireOfflineCopy: true });

    await vi.waitFor(() =>
      expect(tauriCommandsMock.replicaCacheAsset).toHaveBeenCalledWith(
        'https://collab.example.test',
        'hosted-vault',
        'asset-1',
        'YXNzZXQ=',
      ),
    );
  });

  it('still opens a hosted vault when replica seeding fails', async () => {
    const manifest = { vaultId: 'hosted-vault', sequence: 1, files: [] };
    tauriCommandsMock.replicaReadManifest.mockResolvedValue(manifest);
    tauriCommandsMock.replicaReadSyncState.mockResolvedValue({
      manifestSequence: 1,
      lastSyncedAt: '2026-06-17T00:00:00Z',
      status: 'idle',
    });
    tauriCommandsMock.hostedVaultRequest.mockImplementation((_url, _method, path) =>
      path.endsWith('/manifest')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({
            vaultId: 'hosted-vault',
            baseSequence: 1,
            sequence: 1,
            changedFiles: [],
          }),
    );

    await useVaultStore.getState().openHostedVault(hostedVault);

    expect(useVaultStore.getState().vault).toEqual(hostedVault);
    expect(useVaultStore.getState().isLoading).toBe(false);
  });
});
