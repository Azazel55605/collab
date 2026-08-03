import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { HostedVault, ReplicaSummary } from '../mobileTauri';
import { useMobileStore } from './store';

const SERVER = 'https://collab.example.com';

const VAULT: HostedVault = {
  id: 'v1',
  name: 'Research',
  role: 'editor',
  status: 'active',
  members: 2,
  storageBytes: 2048,
  manifestSequence: 5,
  updatedAt: null,
  capabilities: ['vault.offlineCopy'],
};

const MANIFEST = {
  vaultId: 'v1',
  sequence: 5,
  files: [
    {
      id: 'doc-1',
      parentId: null,
      name: 'plan.md',
      relativePath: 'plan.md',
      kind: 'document',
      documentType: 'note',
      state: 'active',
      updatedAt: null,
      currentRevision: { contentHash: 'h-doc', sizeBytes: 5 },
    },
    {
      id: 'asset-1',
      parentId: null,
      name: 'pic.png',
      relativePath: 'pic.png',
      kind: 'asset',
      documentType: null,
      state: 'active',
      updatedAt: null,
      currentRevision: { contentHash: 'h-asset', sizeBytes: 9 },
    },
    {
      id: 'folder-1',
      parentId: null,
      name: 'Docs',
      relativePath: 'Docs',
      kind: 'folder',
      documentType: null,
      state: 'active',
      updatedAt: null,
      currentRevision: null,
    },
  ],
};

function resetStore() {
  useMobileStore.setState({
    restored: false,
    servers: [],
    restoringServers: {},
    statuses: {},
    vaults: {},
    vaultsBusy: {},
    selected: null,
    files: [],
    filesBusy: false,
    filesError: null,
    filesOffline: false,
    fileCache: {},
    replicas: {},
    backgroundJobs: [],
    offlineBusy: {},
    offlineProgress: {},
      offlineError: null,
      calendarSyncing: false,
      calendarSyncProgress: {},
      calendarSyncResults: [],
      calendarConflicts: [],
      calendarMirrorConflicts: [],
      calendarMirrorStatuses: [],
      calendarMirrorProgress: {},
      calendarCacheOrigins: [],
    tab: 'servers',
    folderTrail: [{ id: null, name: 'Root' }],
    activeSheet: null,
  });
}

describe('offline replica store actions', () => {
  beforeEach(() => {
    invoke.mockReset();
    resetStore();
  });

  it('makeOffline seeds the manifest, caches content, and marks the copy available', async () => {
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      switch (command) {
        case 'hosted_vault_request': {
          const path = args.path as string;
          if (path.endsWith('/manifest')) return Promise.resolve(MANIFEST);
          if (path.endsWith('/files/doc-1')) return Promise.resolve({ content: 'hello world' });
          return Promise.reject(new Error(`unexpected path ${path}`));
        }
        case 'hosted_vault_asset_data_url':
          return Promise.resolve('data:image/png;base64,QUJD');
        case 'replica_cached_content_status':
          return Promise.resolve({ present: false, matchesExpectedHash: false, actualSha256: null, sizeBytes: null });
        case 'replica_read_sync_state':
          return Promise.resolve({ manifestSequence: 5, lastSyncedAt: null, status: 'idle' });
        case 'replica_list':
          return Promise.resolve([
            {
              serverUrl: SERVER,
              vaultId: 'v1',
              vaultName: 'Research',
              manifestSequence: 5,
              lastSyncedAt: new Date().toISOString(),
              status: 'idle',
              pendingCount: 0,
              updatedAt: new Date().toISOString(),
              role: 'editor',
              capabilities: ['vault.offlineCopy'],
            },
          ]);
        case 'replica_seed':
        case 'replica_cache_document':
        case 'replica_cache_asset':
        case 'replica_write_sync_state':
          return Promise.resolve(null);
        default:
          return Promise.reject(new Error(`unhandled ${command}`));
      }
    });

    await useMobileStore.getState().makeOffline(SERVER, VAULT);

    // Seeded with the raw manifest (full file entries preserved for the native store).
    expect(invoke).toHaveBeenCalledWith(
      'replica_seed',
      expect.objectContaining({ vaultId: 'v1', manifest: MANIFEST }),
    );
    // Document body cached from the server.
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'doc-1', content: 'hello world' }),
    );
    // Asset bytes cached (base64 payload from the data URL).
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_asset',
      expect.objectContaining({ fileId: 'asset-1', base64Content: 'QUJD' }),
    );
    // Marked offline-available.
    const writeCall = invoke.mock.calls.find((call) => call[0] === 'replica_write_sync_state');
    expect(writeCall?.[1].syncState.offlineAvailableAt).toBeTruthy();
    // Replicas map now includes the vault.
    expect(useMobileStore.getState().replicas['https://collab.example.com::v1']).toBeTruthy();
  });

  it('loadFiles falls back to the replica when the server is not connected', async () => {
    useMobileStore.setState({
      selected: { serverUrl: SERVER, vault: VAULT },
      statuses: {}, // not connected
    });

    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_manifest') return Promise.resolve(MANIFEST);
      if (command === 'replica_cached_content_status') {
        return Promise.resolve({ present: true, matchesExpectedHash: true, actualSha256: 'x', sizeBytes: 5 });
      }
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    await useMobileStore.getState().loadFiles();

    const state = useMobileStore.getState();
    expect(state.filesOffline).toBe(true);
    expect(state.files.map((f) => f.id).sort()).toEqual(['asset-1', 'doc-1', 'folder-1']);
    // Live file listing was never attempted while disconnected.
    expect(invoke).not.toHaveBeenCalledWith('hosted_vault_request', expect.anything());
  });

  it('syncServer joins the native background coordinator for foreground replay', async () => {
    const replica: ReplicaSummary = {
      serverUrl: SERVER,
      vaultId: 'v1',
      vaultName: 'Research',
      manifestSequence: 5,
      lastSyncedAt: null,
      status: 'idle',
      pendingCount: 1,
      updatedAt: '',
      role: 'editor',
      capabilities: ['vault.offlineCopy'],
    };
    useMobileStore.setState({
      statuses: {
        [SERVER]: {
          connected: true,
          serverUrl: SERVER,
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
      replicas: { [SERVER + '::v1']: replica },
    });
    const job = {
      id: 'job-1',
      idempotencyKey: 'mobile-vault-sync',
      kind: 'replica_sync',
      serverUrl: SERVER,
      profileId: null,
      vaultId: 'v1',
      trigger: 'foreground',
      status: 'queued',
      createdAt: '2026-07-27T00:00:00Z',
      startedAt: null,
      finishedAt: null,
      nextRetryAt: null,
      progress: { completed: 0, total: null, unit: 'operations', message: null },
      summary: null,
      errorCategory: null,
      errorMessage: null,
      retryable: false,
    };

    invoke.mockImplementation((command: string) => {
      if (command === 'background_job_run') return Promise.resolve(job);
      if (command === 'background_job_get') {
        return Promise.resolve({ ...job, status: 'succeeded', finishedAt: '2026-07-27T00:00:01Z' });
      }
      if (command === 'replica_list') return Promise.resolve([{ ...replica, pendingCount: 0 }]);
      if (command === 'background_job_list') return Promise.resolve([]);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    await useMobileStore.getState().syncServer(SERVER);

    expect(invoke).toHaveBeenCalledWith(
      'background_job_run',
      expect.objectContaining({
        request: expect.objectContaining({
          kind: 'replica_sync',
          serverUrl: SERVER,
          vaultId: 'v1',
          trigger: 'foreground',
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('background_job_get', { jobId: 'job-1' });
  });

  it('refreshOfflineCopies updates stale offline replicas for connected vaults', async () => {
    useMobileStore.setState({
      statuses: {
        [SERVER]: {
          connected: true,
          serverUrl: SERVER,
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
      vaults: { [SERVER]: [VAULT] },
      replicas: {
        [SERVER + '::v1']: {
          serverUrl: SERVER,
          vaultId: 'v1',
          vaultName: 'Research',
          manifestSequence: 4,
          lastSyncedAt: null,
          status: 'idle',
          pendingCount: 0,
          updatedAt: '',
          role: 'editor',
          capabilities: ['vault.offlineCopy'],
        },
      },
    });

    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      switch (command) {
        case 'hosted_vault_request': {
          const path = args.path as string;
          if (path.endsWith('/manifest')) return Promise.resolve(MANIFEST);
          if (path.endsWith('/files/doc-1')) return Promise.resolve({ content: 'hello world' });
          return Promise.reject(new Error(`unexpected path ${path}`));
        }
        case 'hosted_vault_asset_data_url':
          return Promise.resolve('data:image/png;base64,QUJD');
        case 'replica_cached_content_status':
          return Promise.resolve({
            present: false,
            matchesExpectedHash: false,
            actualSha256: null,
            sizeBytes: null,
          });
        case 'replica_read_sync_state':
          return Promise.resolve({ manifestSequence: 4, lastSyncedAt: null, status: 'idle' });
        case 'replica_list':
          return Promise.resolve([
            {
              serverUrl: SERVER,
              vaultId: 'v1',
              vaultName: 'Research',
              manifestSequence: 5,
              lastSyncedAt: new Date().toISOString(),
              status: 'idle',
              pendingCount: 0,
              updatedAt: new Date().toISOString(),
              role: 'editor',
              capabilities: ['vault.offlineCopy'],
            },
          ]);
        case 'replica_seed':
        case 'replica_cache_document':
        case 'replica_cache_asset':
        case 'replica_write_sync_state':
          return Promise.resolve(null);
        default:
          return Promise.reject(new Error(`unhandled ${command}`));
      }
    });

    await useMobileStore.getState().refreshOfflineCopies(SERVER);

    expect(invoke).toHaveBeenCalledWith(
      'replica_seed',
      expect.objectContaining({ serverUrl: SERVER, vaultId: 'v1', manifest: MANIFEST }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'doc-1', content: 'hello world' }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_asset',
      expect.objectContaining({ fileId: 'asset-1', base64Content: 'QUJD' }),
    );
  });

  it('refreshOfflineCopies skips replicas already at the vault manifest sequence', async () => {
    useMobileStore.setState({
      statuses: {
        [SERVER]: {
          connected: true,
          serverUrl: SERVER,
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
      vaults: { [SERVER]: [VAULT] },
      replicas: {
        [SERVER + '::v1']: {
          serverUrl: SERVER,
          vaultId: 'v1',
          vaultName: 'Research',
          manifestSequence: 5,
          lastSyncedAt: null,
          status: 'idle',
          pendingCount: 0,
          updatedAt: '',
          role: 'editor',
          capabilities: ['vault.offlineCopy'],
        },
      },
    });

    await useMobileStore.getState().refreshOfflineCopies(SERVER);

    expect(invoke).not.toHaveBeenCalledWith(
      'hosted_vault_request',
      expect.objectContaining({ path: '/api/v1/vaults/v1/manifest' }),
    );
  });

  it('loadVaults does not block on automatic offline refresh', async () => {
    const vault = { ...VAULT, id: 'v2', manifestSequence: 6 };
    useMobileStore.setState({
      statuses: {
        [SERVER]: {
          connected: true,
          serverUrl: SERVER,
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
      replicas: {
        [SERVER + '::v2']: {
          serverUrl: SERVER,
          vaultId: 'v2',
          vaultName: 'Research',
          manifestSequence: 4,
          lastSyncedAt: null,
          status: 'idle',
          pendingCount: 0,
          updatedAt: '',
          role: 'editor',
          capabilities: ['vault.offlineCopy'],
        },
      },
    });
    let resolveManifest: (value: typeof MANIFEST) => void = () => {};
    const manifestRequest = new Promise<typeof MANIFEST>((resolve) => {
      resolveManifest = resolve;
    });

    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      switch (command) {
        case 'hosted_vault_request': {
          const path = args.path as string;
          if (path.endsWith('/vaults')) return Promise.resolve([vault]);
          if (path.endsWith('/manifest')) return manifestRequest;
          if (path.endsWith('/files/doc-1')) return Promise.resolve({ content: 'hello world' });
          return Promise.reject(new Error(`unexpected path ${path}`));
        }
        case 'replica_cached_content_status':
          return Promise.resolve({
            present: true,
            matchesExpectedHash: true,
            actualSha256: 'x',
            sizeBytes: 5,
          });
        case 'replica_seed':
        case 'replica_read_sync_state':
        case 'replica_write_sync_state':
        case 'replica_list':
          return Promise.resolve(
            command === 'replica_read_sync_state'
              ? { manifestSequence: 4, lastSyncedAt: null, status: 'idle' }
              : command === 'replica_list'
                ? []
                : null,
          );
        default:
          return Promise.reject(new Error(`unhandled ${command}`));
      }
    });

    await useMobileStore.getState().loadVaults(SERVER);

    expect(useMobileStore.getState().vaults[SERVER]).toEqual([{ ...vault, requireOfflineCopy: false }]);
    expect(invoke).toHaveBeenCalledWith(
      'hosted_vault_request',
      expect.objectContaining({ path: '/api/v1/vaults/v2/manifest' }),
    );
    resolveManifest(MANIFEST);
    await manifestRequest;
  });

  it('goBack closes a sheet, walks up folders, then returns from Files to Vaults', () => {
    const store = useMobileStore.getState;

    // 1. An open sheet is dismissed first.
    useMobileStore.setState({
      tab: 'files',
      folderTrail: [{ id: null, name: 'Root' }, { id: 'a', name: 'A' }],
      activeSheet: { kind: 'fileDetail', fileId: 'doc-1' },
    });
    expect(store().goBack()).toBe(true);
    expect(store().activeSheet).toBeNull();
    // Folder is untouched by the sheet dismissal.
    expect(store().folderTrail).toHaveLength(2);

    // 2. Then back walks up one folder level.
    expect(store().goBack()).toBe(true);
    expect(store().folderTrail).toHaveLength(1);

    // 3. At the selected vault root, back returns to the Vaults overview.
    expect(store().goBack()).toBe(true);
    expect(store().tab).toBe('vaults');

    // 4. Vaults is a root tab, so the shell should ask before quitting.
    expect(store().goBack()).toBe(false);
  });

  it('swipeTab moves through primary tabs only when no overlay is open', () => {
    const store = useMobileStore.getState;
    useMobileStore.setState({ tab: 'vaults', activeSheet: null });

    expect(store().swipeTab(1)).toBe(true);
    expect(store().tab).toBe('files');
    expect(store().swipeTab(-1)).toBe(true);
    expect(store().tab).toBe('vaults');

    useMobileStore.setState({ activeSheet: { kind: 'fileDetail', fileId: 'doc-1' } });
    expect(store().swipeTab(1)).toBe(false);
    expect(store().tab).toBe('vaults');

    useMobileStore.setState({ tab: 'servers', activeSheet: null });
    expect(store().swipeTab(-1)).toBe(false);
    expect(store().tab).toBe('servers');
  });

  it('selectVault opens the vault at its root on the Files tab', async () => {
    useMobileStore.setState({
      statuses: {},
      folderTrail: [{ id: null, name: 'Root' }, { id: 'stale', name: 'Stale' }],
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_manifest') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });
    await useMobileStore.getState().selectVault(SERVER, VAULT);
    expect(useMobileStore.getState().tab).toBe('files');
    expect(useMobileStore.getState().folderTrail).toHaveLength(1);
  });

  describe('widget shortcut targets', () => {
    const FILES = [
      {
        id: 'folder-1',
        parentId: null,
        name: 'Boards',
        relativePath: 'Boards',
        kind: 'folder',
        state: 'active',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'board-1',
        parentId: 'folder-1',
        name: 'Sprint.kanban',
        relativePath: 'Boards/Sprint.kanban',
        kind: 'document',
        documentType: 'kanban',
        state: 'active',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];

    beforeEach(() => {
      useMobileStore.setState({
        vaults: { [SERVER]: [VAULT] },
        statuses: { [SERVER]: { connected: true, serverUrl: SERVER } as never },
        replicas: {},
      });
      invoke.mockImplementation((command: string) => {
        if (command === 'hosted_vault_request') return Promise.resolve(FILES);
        if (command === 'replica_read_manifest') return Promise.resolve(null);
        return Promise.reject(new Error(`unhandled ${command}`));
      });
    });

    it('opens a shortcut target in its folder context', async () => {
      const result = await useMobileStore.getState()
        .openVaultTarget('v1', 'board-1', { cardId: 'card-1' });
      expect(result).toBe('opened');
      expect(useMobileStore.getState().tab).toBe('files');
      expect(useMobileStore.getState().activeSheet)
        .toEqual({ kind: 'kanban', fileId: 'board-1', cardId: 'card-1' });
      // The trail is rebuilt by walking parents so the board opens in context.
      expect(useMobileStore.getState().folderTrail.map((crumb) => crumb.id))
        .toEqual([null, 'folder-1']);
    });

    it('enters a pinned folder without opening a document', async () => {
      const result = await useMobileStore.getState()
        .openVaultTarget('v1', 'folder-1', { expectFolder: true });
      expect(result).toBe('opened');
      expect(useMobileStore.getState().activeSheet).toBeNull();
      expect(useMobileStore.getState().folderTrail.map((crumb) => crumb.id))
        .toEqual([null, 'folder-1']);
    });

    it('reports unavailable vaults and files instead of opening a dead screen', async () => {
      expect(await useMobileStore.getState().openVaultTarget('missing', 'board-1'))
        .toBe('vault-unavailable');
      expect(await useMobileStore.getState().openVaultTarget('v1', 'trashed-file'))
        .toBe('file-unavailable');
      expect(useMobileStore.getState().activeSheet).toBeNull();
    });
  });

  it('removeOffline deletes the replica and drops it from the map', async () => {
    useMobileStore.setState({
      replicas: {
        'https://collab.example.com::v1': {
          serverUrl: SERVER,
          vaultId: 'v1',
          vaultName: 'Research',
          manifestSequence: 5,
          lastSyncedAt: null,
          status: 'idle',
          pendingCount: 0,
          updatedAt: '',
          role: 'editor',
          capabilities: [],
        },
      },
    });
    invoke.mockResolvedValue(null);

    await useMobileStore.getState().removeOffline(SERVER, 'v1');

    expect(invoke).toHaveBeenCalledWith('replica_delete', { serverUrl: SERVER, vaultId: 'v1' });
    expect(useMobileStore.getState().replicas['https://collab.example.com::v1']).toBeUndefined();
  });
});
