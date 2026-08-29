import { create } from 'zustand';

import {
  knownServerFor,
  listKnownServers,
  normalizeHostedServerUrl,
  removeKnownServer,
  upsertKnownServer,
} from '../lib/hostedServers';
import { type ServerConnectionStatus, tauriCommands } from '../lib/tauri';
import type { HostedVaultSummary } from '../types/vault';

import { useSyncStore } from './syncStore';
import { useVaultStore } from './vaultStore';

// Retained for the login form's "last used" prefill; the durable list of servers
// to restore lives in `hostedServers` (`collab-hosted-servers`).
export const SERVER_URL_KEY = 'collab-hosted-server-url';
const NO_SAVED_SESSION_MESSAGE = 'No saved server session was found.';
export const SERVER_SESSION_REFRESH_SKEW_MS = 120_000;

export type RestoreSessionResult = 'connected' | 'failed' | 'skipped';

/**
 * Whether a connected session's access token has already expired. A connected
 * session with an unparseable or absent expiry is treated as not-expired so a
 * malformed timestamp never blocks a working session; reconnect remains
 * available manually.
 */
export function isServerSessionExpired(
  status: ServerConnectionStatus | null,
  now: number = Date.now(),
): boolean {
  if (!status?.connected || !status.accessExpiresAt) return false;
  const expiry = Date.parse(status.accessExpiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/**
 * Whether the session can currently make authenticated server requests: connected
 * to a known server URL with an access token that has not expired.
 */
export function isEffectivelyConnected(
  status: ServerConnectionStatus | null,
  now: number = Date.now(),
): boolean {
  return status?.connected === true && !!status.serverUrl && !isServerSessionExpired(status, now);
}

export function shouldRefreshServerSession(
  status: ServerConnectionStatus | null,
  now: number = Date.now(),
): boolean {
  if (!status?.connected || !status.serverUrl || !status.accessExpiresAt) return !status?.connected;
  const expiry = Date.parse(status.accessExpiresAt);
  return Number.isFinite(expiry) && expiry <= now + SERVER_SESSION_REFRESH_SKEW_MS;
}

/** A single connected server: its status plus its loaded hosted-vault inventory. */
export interface ServerConnection {
  status: ServerConnectionStatus;
  hostedVaults: HostedVaultSummary[];
}

// Deduplicates concurrent `restoreAllSessions` calls (e.g. the React StrictMode
// double-invoked startup effect) so a single restore pass happens per launch.
let restoreInFlight: Promise<RestoreSessionResult> | null = null;

// Inventory is requested by several surfaces (startup restore, reconnect,
// picker/settings mounts, and the connection heartbeat). Share one request per
// server so those callers cannot multiply the same REST call.
const inventoryLoadsInFlight = new Map<string, Promise<void>>();

interface ServerState {
  /** Connected servers, keyed by normalized server URL. */
  connections: Record<string, ServerConnection>;
  isLoading: boolean;
  error: string | null;

  // ── Selectors ──────────────────────────────────────────────────────────────
  connectionFor: (serverUrl: string) => ServerConnection | undefined;
  statusFor: (serverUrl: string) => ServerConnectionStatus | null;
  hostedVaultsFor: (serverUrl: string) => HostedVaultSummary[];
  connectedStatuses: () => ServerConnectionStatus[];

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  /** Reload connection statuses (and each server's vaults) from the backend. */
  refreshAll: () => Promise<void>;
  /** Restore every saved server on launch (reuse live sessions, else reconnect). */
  restoreAllSessions: () => Promise<RestoreSessionResult>;
  connect: (
    serverUrl: string,
    username: string,
    password: string,
    allowInvalidCertificates?: boolean,
    persistAcrossReboots?: boolean,
  ) => Promise<void>;
  reauthenticate: (serverUrl: string, password: string) => Promise<void>;
  reconnect: (
    serverUrl: string,
    allowInvalidCertificates?: boolean,
    persistAcrossReboots?: boolean,
  ) => Promise<void>;
  /**
   * Quiet, best-effort reconnect for one server from its stored refresh token.
   * Never toggles `isLoading`/`error` and only mutates the store on success, so a
   * failed background retry produces no UI churn. Drives the auto-reconnect loop.
   */
  autoReconnect: (serverUrl: string) => Promise<RestoreSessionResult>;
  disconnect: (serverUrl: string) => Promise<void>;
  loadHostedVaults: (serverUrl: string, options?: { quiet?: boolean }) => Promise<void>;
  createHostedVault: (serverUrl: string, name: string) => Promise<HostedVaultSummary>;
}

export const useServerStore = create<ServerState>()((set, get) => {
  const setConnection = (status: ServerConnectionStatus, hostedVaults: HostedVaultSummary[]) => {
    if (!status.serverUrl) return;
    const serverUrl = normalizeHostedServerUrl(status.serverUrl);
    const normalizedStatus = status.serverUrl === serverUrl ? status : { ...status, serverUrl };
    set((state) => ({
      connections: {
        ...state.connections,
        [serverUrl]: { status: normalizedStatus, hostedVaults },
      },
    }));
  };

  const removeConnection = (serverUrl: string) => {
    const normalized = normalizeHostedServerUrl(serverUrl);
    set((state) => {
      if (!(normalized in state.connections)) return {};
      const next = { ...state.connections };
      delete next[normalized];
      return { connections: next };
    });
  };

  return {
    connections: {},
    isLoading: false,
    error: null,

    connectionFor: (serverUrl) => get().connections[normalizeHostedServerUrl(serverUrl)],
    statusFor: (serverUrl) =>
      get().connections[normalizeHostedServerUrl(serverUrl)]?.status ?? null,
    hostedVaultsFor: (serverUrl) =>
      get().connections[normalizeHostedServerUrl(serverUrl)]?.hostedVaults ?? [],
    connectedStatuses: () => Object.values(get().connections).map((c) => c.status),

    refreshAll: async () => {
      set({ isLoading: true, error: null });
      try {
        const statuses = await tauriCommands.serverConnectionStatuses();
        // Rebuild the connection map from the authoritative backend list.
        const previous = get().connections;
        const connections: Record<string, ServerConnection> = {};
        for (const status of statuses) {
          if (!status.connected || !status.serverUrl) continue;
          connections[status.serverUrl] = {
            status,
            hostedVaults: previous[status.serverUrl]?.hostedVaults ?? [],
          };
        }
        set({ connections, isLoading: false });
        await Promise.all(
          Object.keys(connections).map((serverUrl) =>
            get()
              .loadHostedVaults(serverUrl)
              .catch(() => {}),
          ),
        );
      } catch (error) {
        set({ isLoading: false, error: String(error) });
      }
    },

    restoreAllSessions: () => {
      if (restoreInFlight) return restoreInFlight;
      const attempt = (async (): Promise<RestoreSessionResult> => {
        const servers = listKnownServers();
        if (servers.length === 0) return 'skipped';
        await tauriCommands
          .backgroundServerReplace(
            servers.map((server) => ({
              serverUrl: server.serverUrl,
              allowInvalidCertificates: server.allowInvalidCertificates,
              persistAcrossReboots: server.persistAcrossReboots,
              backgroundSyncEnabled: true,
              profileIds: [],
              updatedAt: new Date().toISOString(),
            })),
          )
          .catch(() => {
            // Phase 1 migration is best-effort. Foreground session restoration
            // must remain available if the native registry cannot be persisted.
          });
        // Adopt any still-live in-memory sessions first (e.g. after a soft reload).
        try {
          const statuses = await tauriCommands.serverConnectionStatuses();
          for (const status of statuses) {
            if (status.connected && status.serverUrl)
              setConnection(status, get().connections[status.serverUrl]?.hostedVaults ?? []);
          }
        } catch {
          // Fall through to per-server refresh-token reconnects.
        }
        const results = await Promise.all(
          servers.map(async (server): Promise<RestoreSessionResult> => {
            if (isEffectivelyConnected(get().statusFor(server.serverUrl))) {
              await get()
                .loadHostedVaults(server.serverUrl)
                .catch(() => {});
              return 'connected';
            }
            try {
              await get().reconnect(
                server.serverUrl,
                server.allowInvalidCertificates,
                server.persistAcrossReboots,
              );
              return 'connected';
            } catch (error) {
              return String(error).includes(NO_SAVED_SESSION_MESSAGE) ? 'skipped' : 'failed';
            }
          }),
        );
        if (results.includes('connected')) return 'connected';
        if (results.includes('failed')) return 'failed';
        return 'skipped';
      })();
      restoreInFlight = attempt;
      const clearAttempt = () => {
        if (restoreInFlight === attempt) restoreInFlight = null;
      };
      void attempt.then(clearAttempt, clearAttempt);
      return attempt;
    },

    connect: async (
      serverUrl,
      username,
      password,
      allowInvalidCertificates = false,
      persistAcrossReboots = false,
    ) => {
      set({ isLoading: true, error: null });
      try {
        const status = await tauriCommands.connectServer(
          serverUrl,
          username,
          password,
          allowInvalidCertificates,
          persistAcrossReboots,
        );
        upsertKnownServer({
          serverUrl: status.serverUrl ?? serverUrl,
          username,
          allowInvalidCertificates,
          persistAcrossReboots,
        });
        setConnection(status, []);
        set({ isLoading: false });
        await get()
          .loadHostedVaults(status.serverUrl ?? serverUrl)
          .catch(() => {
            // Authentication succeeded. Keep the live session and let inventory
            // refresh retry independently instead of forcing another login.
          });
      } catch (error) {
        set({ isLoading: false, error: String(error) });
        throw error;
      }
    },

    reauthenticate: async (serverUrl, password) => {
      const known = knownServerFor(serverUrl);
      if (!known) throw new Error('This server is not saved. Add it again to sign in.');
      set({ isLoading: true, error: null });
      try {
        const status = await tauriCommands.reauthenticateServer(
          known.serverUrl,
          known.username,
          password,
          known.allowInvalidCertificates,
          known.persistAcrossReboots,
        );
        setConnection(
          status,
          get().connections[status.serverUrl ?? known.serverUrl]?.hostedVaults ?? [],
        );
        set({ isLoading: false });
        await get()
          .loadHostedVaults(status.serverUrl ?? known.serverUrl)
          .catch(() => {
            // The replacement session is valid even if vault inventory is
            // temporarily unavailable.
          });
      } catch (error) {
        set({ isLoading: false, error: String(error) });
        throw error;
      }
    },

    reconnect: async (
      serverUrl,
      allowInvalidCertificates = false,
      persistAcrossReboots = false,
    ) => {
      set({ isLoading: true, error: null });
      try {
        const status = await tauriCommands.reconnectServer(
          serverUrl,
          allowInvalidCertificates,
          persistAcrossReboots,
        );
        setConnection(status, get().connections[status.serverUrl ?? serverUrl]?.hostedVaults ?? []);
        set({ isLoading: false });
        await get()
          .loadHostedVaults(status.serverUrl ?? serverUrl)
          .catch(() => {
            // Session restoration and inventory availability are separate states.
          });
      } catch (error) {
        set({ isLoading: false, error: String(error) });
        throw error;
      }
    },

    autoReconnect: async (serverUrl) => {
      const known = knownServerFor(serverUrl);
      if (!known) return 'skipped';
      const status = get().statusFor(serverUrl);
      if (isEffectivelyConnected(status) && !shouldRefreshServerSession(status)) return 'connected';
      try {
        const status = await tauriCommands.reconnectServer(
          serverUrl,
          known.allowInvalidCertificates,
          known.persistAcrossReboots,
        );
        // Only mutate the store on success so a failed background attempt causes
        // no state churn and no re-trigger of the reconnect loop.
        setConnection(status, get().connections[status.serverUrl ?? serverUrl]?.hostedVaults ?? []);
        set({ error: null });
        await get()
          .loadHostedVaults(status.serverUrl ?? serverUrl, { quiet: true })
          .catch(() => {
            // The heartbeat retries inventory without invalidating the session.
          });
        return 'connected';
      } catch (error) {
        return String(error).includes(NO_SAVED_SESSION_MESSAGE) ? 'skipped' : 'failed';
      }
    },

    disconnect: async (serverUrl) => {
      await tauriCommands.disconnectServer(serverUrl);
      removeKnownServer(serverUrl);
      removeConnection(serverUrl);
      set({ error: null });
    },

    loadHostedVaults: async (serverUrl, options) => {
      const normalizedServerUrl = normalizeHostedServerUrl(serverUrl);
      const status = get().statusFor(normalizedServerUrl);
      if (!status?.connected || !status.serverUrl) return;
      const quiet = options?.quiet === true;
      if (!quiet) set({ isLoading: true, error: null });

      let load = inventoryLoadsInFlight.get(normalizedServerUrl);
      if (!load) {
        load = (async () => {
          const hostedVaults = await tauriCommands.hostedVaultRequest<HostedVaultSummary[]>(
            status.serverUrl!,
            'GET',
            '/api/v1/vaults',
          );
          const currentStatus = get().statusFor(normalizedServerUrl);
          // A reconnect or password login may replace the session while this
          // inventory request is in flight. Never restore the older status.
          if (currentStatus !== status || !isEffectivelyConnected(currentStatus)) return;
          useVaultStore
            .getState()
            .refreshHostedVaultMetadata(currentStatus.serverUrl!, hostedVaults);
          setConnection(currentStatus, hostedVaults);
          void useSyncStore
            .getState()
            .refreshOfflineCopiesForServer(currentStatus.serverUrl!, hostedVaults)
            .catch(() => {
              // Background replica refresh failures are represented by sync
              // state and retried by a later inventory heartbeat.
            });
        })();
        inventoryLoadsInFlight.set(normalizedServerUrl, load);
        const clearLoad = () => {
          if (inventoryLoadsInFlight.get(normalizedServerUrl) === load) {
            inventoryLoadsInFlight.delete(normalizedServerUrl);
          }
        };
        void load.then(clearLoad, clearLoad);
      }

      try {
        await load;
        if (!quiet) set({ isLoading: false });
      } catch (error) {
        if (!quiet && get().statusFor(normalizedServerUrl) === status) {
          set({ isLoading: false, error: String(error) });
        }
        throw error;
      }
    },

    createHostedVault: async (serverUrl, name) => {
      const status = get().statusFor(serverUrl);
      if (!isEffectivelyConnected(status) || !status?.serverUrl) {
        throw new Error('Connect to a Collab server before creating a hosted vault.');
      }
      const created = await tauriCommands.hostedVaultRequest<HostedVaultSummary>(
        status.serverUrl,
        'POST',
        '/api/v1/vaults',
        { name },
      );
      // The creator becomes the vault admin/owner; refresh so it appears in the inventory.
      await get().loadHostedVaults(status.serverUrl);
      return created;
    },
  };
});
