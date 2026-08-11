import { create } from 'zustand';

import {
  connectServer,
  backgroundJobGet,
  backgroundJobList,
  backgroundStatusSnapshot,
  backgroundJobRun,
  cancelAndroidBackgroundProfile,
  disconnectServer,
  HostedFileEntry,
  HostedVault,
  listHostedVaults,
  listVaultFiles,
  loadConnectionStatuses,
  reauthenticateServer,
  reconnectServer,
  reconcileAndroidBackground,
  replicaList,
  ReplicaSummary,
  serverHasSavedSession,
  ServerConnectionStatus,
} from '../mobileTauri';
import type { BackgroundJobRecord } from '../mobileTauri';
import {
  KnownServer,
  listKnownServers,
  normalizeServerUrl,
  removeKnownServer,
  upsertKnownServer,
} from '../lib/servers';
import {
  FileCacheState,
  fileCacheState,
  makeVaultAvailableOffline,
  OfflineProgress,
  readReplicaFiles,
  removeOfflineCopy,
  replicaKey,
  refreshVaultOfflineContents,
} from '../lib/replica';
import { runTopBackDismiss } from '../lib/backStack';
import { listenToBackgroundEvents } from '../lib/backgroundEvents';
import type { VaultSyncedEvent } from '../lib/backgroundEvents';
import type { BackgroundStatusSnapshot } from '../../../../src/lib/tauri';
import { shouldAlwaysCreateOfflineCopy } from '../lib/preferences';
import {
  listMobileCalendarCacheOrigins,
  mobileCalendarProfileId,
  removeMobileCalendarCache,
  syncMobileCalendars,
} from '../lib/calendarSync';
import type {
  CalendarMirrorConflict,
  CalendarMirrorGroupStatus,
  CalendarMirrorProgress,
  CalendarOperationFailure,
} from '../../../../src/types/calendar';
import type { CalendarOriginSyncResult, CalendarSyncProgress } from '../../../../src/lib/calendarSync';

export interface SelectedVault {
  serverUrl: string;
  vault: HostedVault;
}

export type Tab = 'servers' | 'vaults' | 'files' | 'calendar' | 'settings';
export const TAB_ORDER: Tab[] = ['servers', 'vaults', 'files', 'calendar', 'settings'];

export interface Crumb {
  id: string | null;
  name: string;
}

/** A dismissible overlay tracked centrally so the Android back button can close
 * it before navigating folders or tabs. */
export type ActiveSheet =
  | { kind: 'fileDetail'; fileId: string }
  | { kind: 'note'; fileId: string }
  | { kind: 'kanban'; fileId: string; cardId?: string }
  /** A `.sheet` workbook opened in the mobile spreadsheet screen. */
  | { kind: 'workbook'; fileId: string }
  | { kind: 'viewer'; fileId: string }
  | { kind: 'removeOffline'; serverUrl: string; vault: HostedVault }
  | null;

const ROOT_CRUMB: Crumb = { id: null, name: 'Root' };
const EAGER_ASSET_CACHE_STATUS_LIMIT = 2 * 1024 * 1024;
const AUTO_OFFLINE_REFRESH_COOLDOWN_MS = 60_000;
const offlineRefreshInFlight = new Set<string>();
const offlineRefreshLastStartedAt = new Map<string, number>();
const initiallyKnownServers = listKnownServers();

interface MobileState {
  restored: boolean;
  servers: KnownServer[];
  /** Saved servers whose startup session restoration is still in progress. */
  restoringServers: Record<string, boolean>;

  // ── Navigation ────────────────────────────────────────────────────────────
  tab: Tab;
  folderTrail: Crumb[];
  activeSheet: ActiveSheet;
  setTab: (tab: Tab) => void;
  enterFolder: (crumb: Crumb) => void;
  folderJumpTo: (index: number) => void;
  openSheet: (sheet: NonNullable<ActiveSheet>) => void;
  closeSheet: () => void;
  /** Handle an Android back press. Returns true if it navigated internally. */
  goBack: () => boolean;
  /** Move between top-level tabs by relative offset. Returns true when changed. */
  swipeTab: (delta: -1 | 1) => boolean;

  /** One entry per currently connected server, keyed by normalized URL. */
  statuses: Record<string, ServerConnectionStatus>;
  vaults: Record<string, HostedVault[]>;
  vaultsBusy: Record<string, boolean>;
  selected: SelectedVault | null;
  files: HostedFileEntry[];
  filesBusy: boolean;
  filesError: string | null;
  /** True when the current file list was read from the local replica (offline). */
  filesOffline: boolean;
  /** Per-file cache state for the selected vault, keyed by file id. */
  fileCache: Record<string, FileCacheState>;

  /** Offline replicas present on this device, keyed by `replicaKey`. */
  replicas: Record<string, ReplicaSummary>;
  offlineBusy: Record<string, boolean>;
  offlineProgress: Record<string, OfflineProgress | null>;
  offlineError: string | null;
  calendarSyncing: boolean;
  calendarSyncProgress: Record<string, CalendarSyncProgress>;
  calendarSyncResults: CalendarOriginSyncResult[];
  calendarConflicts: CalendarOperationFailure[];
  calendarMirrorConflicts: CalendarMirrorConflict[];
  calendarMirrorStatuses: CalendarMirrorGroupStatus[];
  calendarMirrorProgress: Record<string, CalendarMirrorProgress>;
  calendarCacheOrigins: Array<{ serverUrl: string; userId: string }>;
  backgroundJobs: BackgroundJobRecord[];
  /** Live coordinator status, pushed from native. Null until the first event. */
  backgroundStatus: BackgroundStatusSnapshot | null;

  restore: () => Promise<void>;
  /** Starts listening for native background events. Returns a disposer. */
  watchBackgroundEvents: () => () => void;
  refreshStatuses: () => Promise<void>;
  refreshBackgroundJobs: () => Promise<void>;
  loadReplicas: () => Promise<void>;
  /** Replay every offline-queued write for a connected server's replicas. */
  syncServer: (serverUrl: string) => Promise<void>;
  syncCalendars: () => Promise<void>;
  removeCalendarCachesForServer: (serverUrl: string) => Promise<void>;
  /** Keep already-enabled offline copies current while their server is connected. */
  refreshOfflineCopies: (serverUrl?: string) => Promise<void>;
  connect: (
    serverUrl: string,
    username: string,
    password: string,
    opts: {
      allowInvalidCertificates: boolean;
      persistAcrossReboots: boolean;
      offlineCopyMode?: 'inherit' | 'always' | 'never';
    },
  ) => Promise<void>;
  reauthenticate: (serverUrl: string, password: string) => Promise<void>;
  reconnect: (serverUrl: string) => Promise<void>;
  disconnect: (serverUrl: string) => Promise<void>;
  loadVaults: (serverUrl: string) => Promise<void>;
  selectVault: (serverUrl: string, vault: HostedVault) => Promise<void>;
  clearSelection: () => void;
  loadFiles: () => Promise<void>;
  refreshCacheStatus: (files: HostedFileEntry[]) => Promise<void>;
  replaceFile: (file: HostedFileEntry) => void;
  makeOffline: (serverUrl: string, vault: HostedVault) => Promise<void>;
  removeOffline: (serverUrl: string, vaultId: string) => Promise<void>;
  /** Opens a widget shortcut target by stable vault/file identity. Returns why
   * it could not be opened so the caller can show a recovery surface. */
  openVaultTarget: (
    vaultId: string,
    fileId: string,
    options?: { cardId?: string; expectFolder?: boolean },
  ) => Promise<VaultTargetResult>;
}

export type VaultTargetResult = 'opened' | 'vault-unavailable' | 'file-unavailable';

function isConnected(status: ServerConnectionStatus | undefined): boolean {
  return !!status && status.connected;
}

export const useMobileStore = create<MobileState>((set, get) => ({
  restored: false,
  servers: initiallyKnownServers,
  restoringServers: Object.fromEntries(
    initiallyKnownServers.map((server) => [normalizeServerUrl(server.serverUrl), true]),
  ),
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
  backgroundJobs: [],
  backgroundStatus: null,

  tab: 'servers',
  folderTrail: [ROOT_CRUMB],
  activeSheet: null,

  setTab: (tab) => set({ tab }),
  enterFolder: (crumb) => set((state) => ({ folderTrail: [...state.folderTrail, crumb] })),
  folderJumpTo: (index) =>
    set((state) => ({ folderTrail: state.folderTrail.slice(0, index + 1) })),
  openSheet: (sheet) => set({ activeSheet: sheet }),
  closeSheet: () => set({ activeSheet: null }),

  goBack: () => {
    const { activeSheet, tab, folderTrail } = get();
    // Screen-local surfaces (a Settings category, a bottom sheet, a popover)
    // unwind first, most recently opened first.
    if (runTopBackDismiss()) return true;
    if (activeSheet) {
      set({ activeSheet: null });
      return true;
    }
    if (tab === 'files' && folderTrail.length > 1) {
      set({ folderTrail: folderTrail.slice(0, -1) });
      return true;
    }
    if (tab === 'files') {
      set({ tab: 'vaults' });
      return true;
    }
    return false;
  },

  swipeTab: (delta) => {
    const { activeSheet, tab } = get();
    if (activeSheet) return false;
    const current = TAB_ORDER.indexOf(tab);
    const next = current + delta;
    if (current < 0 || next < 0 || next >= TAB_ORDER.length) return false;
    set({ tab: TAB_ORDER[next] });
    return true;
  },

  refreshStatuses: async () => {
    const statuses = await loadConnectionStatuses();
    const map: Record<string, ServerConnectionStatus> = {};
    for (const status of statuses) {
      if (status.serverUrl) map[normalizeServerUrl(status.serverUrl)] = status;
    }
    set({ statuses: map });
  },

  refreshBackgroundJobs: async () => {
    set({ backgroundJobs: await backgroundJobList(30) });
  },

  watchBackgroundEvents: () => {
    // A WorkManager run can already be in flight when the app opens, and the
    // next event is up to a progress interval away. Without this seed the
    // indicator stays blank through the part of a sync the user is most likely
    // to be watching.
    void backgroundStatusSnapshot()
      .then((snapshot) => set({ backgroundStatus: snapshot }))
      .catch(() => {});
    return listenToBackgroundEvents({
      onStatus: (snapshot: BackgroundStatusSnapshot) => {
        set({ backgroundStatus: snapshot });
      },
      onVaultSynced: (event: VaultSyncedEvent) => {
        // Only the vault being looked at needs a reload; refreshing every vault
        // on every event would undo the point of pushing these at all.
        const selected = get().selected;
        if (
          !selected
          || selected.vault.id !== event.vaultId
          || normalizeServerUrl(selected.serverUrl) !== normalizeServerUrl(event.serverUrl)
        ) {
          return;
        }
        void get().loadFiles().catch(() => {});
      },
    });
  },

  restore: async () => {
    const servers = listKnownServers();
    set({
      servers,
      restoringServers: Object.fromEntries(
        servers.map((server) => [normalizeServerUrl(server.serverUrl), true]),
      ),
    });
    const finishRestoringServer = (serverUrl: string) => {
      set((state) => {
        if (!state.restoringServers[serverUrl]) return {};
        const restoringServers = { ...state.restoringServers };
        delete restoringServers[serverUrl];
        return { restoringServers };
      });
    };
    try {
      await get().refreshStatuses();
    } catch (reason) {
      set({ restoringServers: {} });
      throw reason;
    }
    // Quietly reconnect each saved server that has a stored refresh token and is
    // not already connected. Failures are non-fatal — the user can reconnect
    // manually from the Servers screen.
    await Promise.all(
      servers.map(async (server) => {
        const key = normalizeServerUrl(server.serverUrl);
        if (isConnected(get().statuses[key])) {
          finishRestoringServer(key);
          return;
        }
        try {
          if (!(await serverHasSavedSession(server.serverUrl))) return;
          const status = await reconnectServer(server.serverUrl, {
            allowInvalidCertificates: server.allowInvalidCertificates,
            persistAcrossReboots: server.persistAcrossReboots,
          });
          if (status.connected && status.serverUrl) {
            const statusKey = normalizeServerUrl(status.serverUrl);
            set((state) => ({
              statuses: { ...state.statuses, [statusKey]: status },
            }));
          }
        } catch {
          // Leave disconnected; surfaced as "Reconnect" on the Servers screen.
        } finally {
          finishRestoringServer(key);
        }
      }),
    );
    await get().refreshStatuses();
    // Load offline replicas first so a reconnected server can immediately replay
    // any writes queued while it was offline, then preload vault inventories.
    await get().loadReplicas().catch(() => {});
    const calendarCacheOrigins = await listMobileCalendarCacheOrigins().catch(() => []);
    set({ calendarCacheOrigins });
    await Promise.all([
      ...Object.keys(get().statuses).map((serverUrl) =>
        get().loadVaults(serverUrl).catch(() => {}),
      ),
      ...Object.keys(get().statuses).map((serverUrl) =>
        get().syncServer(serverUrl).catch(() => {}),
      ),
      get().syncCalendars().catch(() => {}),
      get().refreshBackgroundJobs().catch(() => {}),
    ]);
    await reconcileAndroidBackground(mobileCalendarProfileId()).catch(() => {});
    set({ restored: true });
  },

  loadReplicas: async () => {
    const summaries = await replicaList();
    const map: Record<string, ReplicaSummary> = {};
    for (const summary of summaries) {
      map[replicaKey(normalizeServerUrl(summary.serverUrl), summary.vaultId)] = summary;
    }
    set({ replicas: map });
  },

  syncServer: async (serverUrl) => {
    const normalized = normalizeServerUrl(serverUrl);
    if (!isConnected(get().statuses[normalized])) return;
    const replicas = Object.values(get().replicas).filter(
      (replica) => normalizeServerUrl(replica.serverUrl) === normalized,
    );
    for (const replica of replicas) {
      try {
        let job = await backgroundJobRun({
          idempotencyKey: `mobile:${replica.vaultId}:${crypto.randomUUID()}`,
          kind: 'replica_sync',
          serverUrl: normalized,
          vaultId: replica.vaultId,
          trigger: 'foreground',
          runtimeBudgetSeconds: 120,
        });
        while (job.status === 'queued' || job.status === 'running') {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
          const next = await backgroundJobGet(job.id);
          if (!next) throw new Error('The native background sync job was lost.');
          job = next;
        }
      } catch {
        // Still offline for this vault; leave its queue for the next attempt.
      }
    }
    // Refresh pending counts, and re-read the open vault so replayed edits and
    // any resulting server state are reflected.
    await get().loadReplicas().catch(() => {});
    await get().refreshBackgroundJobs().catch(() => {});
    const selected = get().selected;
    if (selected && normalizeServerUrl(selected.serverUrl) === normalized) {
      await get().loadFiles().catch(() => {});
    }
  },

  syncCalendars: async () => {
    const origins = Object.values(get().statuses).flatMap((status) => (
      status.connected && status.serverUrl && status.user
        ? [{ serverUrl: normalizeServerUrl(status.serverUrl), userId: status.user.id }]
        : []
    ));
    if (origins.length === 0 || get().calendarSyncing) return;
    set({ calendarSyncing: true });
    try {
      const synced = await syncMobileCalendars(
        origins,
        (progress) => {
          set((state) => ({
            calendarSyncProgress: { ...state.calendarSyncProgress, [progress.originKey]: progress },
          }));
        },
        (mirrorProgress) => {
          set((state) => ({
            calendarMirrorProgress: {
              ...state.calendarMirrorProgress,
              [mirrorProgress.groupId]: mirrorProgress,
            },
          }));
        },
      );
      set({
        calendarSyncResults: synced.results,
        calendarConflicts: synced.conflicts,
        calendarMirrorConflicts: synced.mirrorConflicts,
        calendarMirrorStatuses: synced.mirrorStatuses,
        calendarCacheOrigins: synced.cacheOrigins,
      });
    } finally {
      set({ calendarSyncing: false });
    }
  },

  removeCalendarCachesForServer: async (serverUrl) => {
    const normalized = normalizeServerUrl(serverUrl);
    const matching = get().calendarCacheOrigins.filter(
      (origin) => normalizeServerUrl(origin.serverUrl) === normalized,
    );
    for (const origin of matching) await removeMobileCalendarCache(origin);
    set({ calendarCacheOrigins: await listMobileCalendarCacheOrigins() });
  },

  refreshOfflineCopies: async (serverUrl) => {
    const normalizedFilter = serverUrl ? normalizeServerUrl(serverUrl) : null;
    const servers = Object.keys(get().statuses).filter(
      (entry) =>
        isConnected(get().statuses[entry]) && (!normalizedFilter || entry === normalizedFilter),
    );
    if (servers.length === 0) return;

    const refreshed = new Set<string>();
    for (const normalized of servers) {
      const vaultsById = new Map((get().vaults[normalized] ?? []).map((vault) => [vault.id, vault]));
      const replicas = Object.values(get().replicas).filter(
        (replica) => normalizeServerUrl(replica.serverUrl) === normalized,
      );

      for (const replica of replicas) {
        const vault = vaultsById.get(replica.vaultId);
        if (!vault || vault.status !== 'active') continue;
        const key = replicaKey(normalized, vault.id);
        if (get().offlineBusy[key]) continue;
        if (offlineRefreshInFlight.has(key)) continue;
        if (replica.manifestSequence >= vault.manifestSequence) continue;

        const now = Date.now();
        const lastStartedAt = offlineRefreshLastStartedAt.get(key) ?? 0;
        if (now - lastStartedAt < AUTO_OFFLINE_REFRESH_COOLDOWN_MS) continue;

        try {
          offlineRefreshInFlight.add(key);
          offlineRefreshLastStartedAt.set(key, now);
          await refreshVaultOfflineContents(normalized, vault);
          refreshed.add(key);
        } catch {
          // Auto-refresh is best-effort. The stale badge remains actionable.
        } finally {
          offlineRefreshInFlight.delete(key);
        }
      }
    }

    if (refreshed.size === 0) return;
    await get().loadReplicas().catch(() => {});

    const selected = get().selected;
    if (!selected || !refreshed.has(replicaKey(selected.serverUrl, selected.vault.id))) return;
    set({ fileCache: {} });
    await get().refreshCacheStatus(get().files).catch(() => {});
  },

  connect: async (serverUrl, username, password, opts) => {
    const normalized = normalizeServerUrl(serverUrl);
    await connectServer(normalized, username, password, opts);
    upsertKnownServer({
      serverUrl: normalized,
      username,
      allowInvalidCertificates: opts.allowInvalidCertificates,
      persistAcrossReboots: opts.persistAcrossReboots,
      offlineCopyMode: opts.offlineCopyMode ?? 'inherit',
    });
    set({ servers: listKnownServers() });
    await get().refreshStatuses();
    await get().loadReplicas().catch(() => {});
    await get().loadVaults(normalized);
    await get().syncServer(normalized).catch(() => {});
    await get().syncCalendars().catch(() => {});
    await reconcileAndroidBackground(mobileCalendarProfileId()).catch(() => {});
  },

  reauthenticate: async (serverUrl, password) => {
    const normalized = normalizeServerUrl(serverUrl);
    const server = get().servers.find((entry) => normalizeServerUrl(entry.serverUrl) === normalized);
    if (!server) throw new Error('This server is not saved. Add it again to sign in.');
    await reauthenticateServer(normalized, server.username, password, {
      allowInvalidCertificates: server.allowInvalidCertificates,
      persistAcrossReboots: server.persistAcrossReboots,
    });
    await get().refreshStatuses();
    await get().loadReplicas().catch(() => {});
    await get().loadVaults(normalized);
    await get().syncServer(normalized).catch(() => {});
    await get().syncCalendars().catch(() => {});
    await reconcileAndroidBackground(mobileCalendarProfileId()).catch(() => {});
  },

  reconnect: async (serverUrl) => {
    const normalized = normalizeServerUrl(serverUrl);
    const server = get().servers.find((entry) => normalizeServerUrl(entry.serverUrl) === normalized);
    await reconnectServer(normalized, {
      allowInvalidCertificates: server?.allowInvalidCertificates ?? false,
      persistAcrossReboots: server?.persistAcrossReboots ?? true,
    });
    await get().refreshStatuses();
    await get().loadReplicas().catch(() => {});
    await get().loadVaults(normalized);
    await get().syncServer(normalized).catch(() => {});
    await get().syncCalendars().catch(() => {});
    await reconcileAndroidBackground(mobileCalendarProfileId()).catch(() => {});
  },

  disconnect: async (serverUrl) => {
    const normalized = normalizeServerUrl(serverUrl);
    await disconnectServer(normalized);
    removeKnownServer(normalized);
    const vaults = { ...get().vaults };
    delete vaults[normalized];
    const selected = get().selected;
    set({
      servers: listKnownServers(),
      vaults,
      selected: selected && selected.serverUrl === normalized ? null : selected,
      files: selected && selected.serverUrl === normalized ? [] : get().files,
    });
    await get().refreshStatuses();
    if (get().servers.length === 0) {
      await cancelAndroidBackgroundProfile(mobileCalendarProfileId()).catch(() => {});
    } else {
      await reconcileAndroidBackground(mobileCalendarProfileId()).catch(() => {});
    }
  },

  loadVaults: async (serverUrl) => {
    const normalized = normalizeServerUrl(serverUrl);
    set((state) => ({ vaultsBusy: { ...state.vaultsBusy, [normalized]: true } }));
    try {
      const vaults = await listHostedVaults(normalized);
      set((state) => ({ vaults: { ...state.vaults, [normalized]: vaults } }));
      void get().refreshOfflineCopies(normalized).catch(() => {});
    } finally {
      set((state) => ({ vaultsBusy: { ...state.vaultsBusy, [normalized]: false } }));
    }
  },

  selectVault: async (serverUrl, vault) => {
    const normalized = normalizeServerUrl(serverUrl);
    set({
      selected: { serverUrl: normalized, vault },
      files: [],
      filesError: null,
      fileCache: {},
      // Open the vault at its root in the Files tab.
      tab: 'files',
      folderTrail: [ROOT_CRUMB],
      activeSheet: null,
    });
    await get().loadFiles();
    const key = replicaKey(normalized, vault.id);
    if (
      (shouldAlwaysCreateOfflineCopy(normalized) || vault.requireOfflineCopy) &&
      vault.capabilities.includes('vault.offlineCopy') &&
      !get().replicas[key] &&
      !get().offlineBusy[key]
    ) {
      void get().makeOffline(normalized, vault).catch(() => {});
    }
  },

  clearSelection: () =>
    set({
      selected: null,
      files: [],
      filesError: null,
      filesOffline: false,
      fileCache: {},
      folderTrail: [ROOT_CRUMB],
    }),

  loadFiles: async () => {
    const selected = get().selected;
    if (!selected) return;
    set({ filesBusy: true, filesError: null });
    const { serverUrl, vault } = selected;
    const connected = isConnected(get().statuses[serverUrl]);

    // Read from the local replica (offline). Returns true when it served files.
    const loadFromReplica = async (): Promise<boolean> => {
      const cached = await readReplicaFiles(serverUrl, vault.id).catch(() => null);
      if (!cached) return false;
      set({ files: cached, filesOffline: true });
      return true;
    };

    try {
      if (connected) {
        const files = (await listVaultFiles(serverUrl, vault.id)).filter(
          (file) => file.state === 'active',
        );
        set({ files, filesOffline: false, fileCache: {} });
      } else if (!(await loadFromReplica())) {
        throw new Error('This vault is not available offline. Reconnect to browse it.');
      }
    } catch (reason) {
      // A live read failed (e.g. airplane mode). Fall back to the replica if present.
      if (connected && (await loadFromReplica())) {
        // Served from cache; clear the transient error.
      } else {
        set({ filesError: reason instanceof Error ? reason.message : String(reason) });
      }
    } finally {
      set({ filesBusy: false });
    }
  },

  refreshCacheStatus: async (files) => {
    const selected = get().selected;
    if (!selected) return;
    const { serverUrl, vault } = selected;
    // Only meaningful when an offline copy exists; otherwise everything is uncached
    // and the browser simply shows no cache badges.
    if (!get().replicas[replicaKey(serverUrl, vault.id)]) return;

    // Check only files not already resolved, and update each badge as it lands
    // (rather than all-at-once) with bounded concurrency so a large folder never
    // blocks the UI thread with a burst of IPC calls.
    const known = get().fileCache;
    const targets = files.filter(
      (file) =>
        (file.kind === 'document' ||
          (file.kind === 'asset' && (file.sizeBytes ?? 0) <= EAGER_ASSET_CACHE_STATUS_LIMIT)) &&
        !(file.id in known),
    );
    if (targets.length === 0) return;

    const stillCurrent = () => {
      const sel = get().selected;
      return !!sel && sel.serverUrl === serverUrl && sel.vault.id === vault.id;
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        if (!stillCurrent()) return;
        const file = targets[cursor++];
        const state = await fileCacheState(serverUrl, vault.id, file).catch(
          () => 'uncached' as FileCacheState,
        );
        if (!stillCurrent()) return;
        set((s) => ({ fileCache: { ...s.fileCache, [file.id]: state } }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
  },

  replaceFile: (file) => {
    set((state) => ({
      files: state.files.map((entry) => (entry.id === file.id ? file : entry)),
      fileCache: { ...state.fileCache, [file.id]: 'cached' },
    }));
  },

  makeOffline: async (serverUrl, vault) => {
    const normalized = normalizeServerUrl(serverUrl);
    const key = replicaKey(normalized, vault.id);
    set((state) => ({
      offlineBusy: { ...state.offlineBusy, [key]: true },
      offlineProgress: { ...state.offlineProgress, [key]: { completed: 0, total: 0 } },
      offlineError: null,
    }));
    try {
      await makeVaultAvailableOffline(normalized, vault, (progress) => {
        set((state) => ({ offlineProgress: { ...state.offlineProgress, [key]: progress } }));
      });
      await get().loadReplicas();
      // Refresh cache badges if this is the open vault.
      if (get().selected && replicaKey(get().selected!.serverUrl, get().selected!.vault.id) === key) {
        await get().refreshCacheStatus(get().files);
      }
    } catch (reason) {
      set({ offlineError: reason instanceof Error ? reason.message : String(reason) });
      throw reason;
    } finally {
      set((state) => ({
        offlineBusy: { ...state.offlineBusy, [key]: false },
        offlineProgress: { ...state.offlineProgress, [key]: null },
      }));
    }
  },

  removeOffline: async (serverUrl, vaultId) => {
    const normalized = normalizeServerUrl(serverUrl);
    const key = replicaKey(normalized, vaultId);
    await removeOfflineCopy(normalized, vaultId);
    const replicas = { ...get().replicas };
    delete replicas[key];
    set({ replicas });
    if (get().selected && replicaKey(get().selected!.serverUrl, get().selected!.vault.id) === key) {
      set({ fileCache: {} });
    }
  },

  openVaultTarget: async (vaultId, fileId, options) => {
    // Resolve by stable identity across the servers this device is signed in
    // to. A widget intent never carries a server URL or a path.
    const match = Object.entries(get().vaults)
      .flatMap(([serverUrl, vaults]) => vaults.map((vault) => ({ serverUrl, vault })))
      .find(({ vault }) => vault.id === vaultId);
    if (!match) return 'vault-unavailable';
    const alreadyOpen = get().selected?.vault.id === vaultId;
    if (!alreadyOpen) {
      await get().selectVault(match.serverUrl, match.vault);
    } else {
      set({ tab: 'files', activeSheet: null, folderTrail: [ROOT_CRUMB] });
    }
    const files = get().files;
    const entry = files.find((file) => file.id === fileId);
    // A target that has been trashed, deleted, or is not readable here is
    // reported so the caller can offer recovery instead of a dead screen.
    if (!entry) return 'file-unavailable';

    // Rebuild the folder trail by walking parents so the file opens in context.
    const trail: Crumb[] = [];
    const byId = new Map(files.map((file) => [file.id, file]));
    let parentId = options?.expectFolder ? entry.id : entry.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      trail.unshift({ id: parent.id, name: parent.name });
      parentId = parent.parentId;
    }
    set({ folderTrail: [ROOT_CRUMB, ...trail] });
    if (options?.expectFolder || entry.kind === 'folder') return 'opened';

    const name = entry.name.toLowerCase();
    if (options?.cardId || name.endsWith('.kanban')) {
      set({ activeSheet: { kind: 'kanban', fileId: entry.id, cardId: options?.cardId } });
    } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
      set({ activeSheet: { kind: 'note', fileId: entry.id } });
    } else if (name.endsWith('.sheet')) {
      set({ activeSheet: { kind: 'workbook', fileId: entry.id } });
    } else if (name.endsWith('.canvas') || name.endsWith('.logic') || name.endsWith('.pdf')) {
      set({ activeSheet: { kind: 'viewer', fileId: entry.id } });
    } else {
      set({ activeSheet: { kind: 'fileDetail', fileId: entry.id } });
    }
    return 'opened';
  },
}));
