import type { KnownServer } from '../../../lib/hostedServers';
import { hostedVaultActivityKey } from '../../../lib/hostedVaultActivity';
import type { ReplicaSummary } from '../../../lib/vaultReplica';
import { isEffectivelyConnected, type ServerConnection } from '../../../store/serverStore';
import {
  type HostedVaultMeta,
  type HostedVaultSummary,
  type MemberRole,
  vaultKind,
  type VaultMeta,
} from '../../../types/vault';

/** How a vault is reached: a local folder, a live hosted vault, or a cached hosted copy. */
export type VaultEntryKind = 'local' | 'hosted' | 'offline';

export interface VaultEntry {
  key: string;
  kind: VaultEntryKind;
  name: string;
  /** Folder path for local vaults, server host for hosted and offline vaults. */
  location: string;
  serverUrl: string | null;
  /** Access summary: "This device", "Editor · 6 members", "Editor · offline copy". */
  detail: string;
  lastOpened: number | null;
  pendingCount: number;
  local?: VaultMeta;
  hosted?: HostedVaultSummary;
  replica?: ReplicaSummary;
}

/**
 * A server as the start screen shows it. `connected` servers list live vaults,
 * `signed-out` servers are saved but have no session, and `offline-only` servers
 * are known only through cached offline copies.
 */
export type ServerEntryState = 'connected' | 'signed-out' | 'offline-only';

export interface ServerEntry {
  serverUrl: string;
  host: string;
  state: ServerEntryState;
  /** Who is signed in, or the saved username for a signed-out server. */
  account: string | null;
  /** Whether authenticated requests (creating a vault) can be made right now. */
  canCreate: boolean;
  vaultCount: number;
  offlineCount: number;
  known: KnownServer | null;
}

export type VaultKindFilter = 'all' | VaultEntryKind;

export interface VaultEntryFilter {
  kind: VaultKindFilter;
  serverUrl: string | null;
  query: string;
}

export function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

function roleLabel(role: MemberRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function replicaRole(replica: ReplicaSummary): MemberRole {
  return replica.role === 'admin' || replica.role === 'editor' || replica.role === 'viewer'
    ? replica.role
    : 'viewer';
}

export function replicaToHostedVaultMeta(replica: ReplicaSummary): HostedVaultMeta {
  return {
    kind: 'hosted',
    id: replica.vaultId,
    hostedVaultId: replica.vaultId,
    serverUrl: replica.serverUrl,
    name: replica.vaultName,
    path: `hosted://${replica.vaultId}`,
    lastOpened: Date.parse(replica.updatedAt) || Date.now(),
    isEncrypted: false,
    role: replicaRole(replica),
    capabilities: replica.capabilities ?? [],
  };
}

/** Connections that list hosted vaults: connected with a known URL. */
export function listedConnections(
  connections: Record<string, ServerConnection>,
): (ServerConnection & { status: { serverUrl: string } })[] {
  return Object.values(connections).filter(
    (c): c is ServerConnection & { status: { serverUrl: string } } =>
      c.status.connected && !!c.status.serverUrl,
  );
}

function compareEntries(left: VaultEntry, right: VaultEntry): number {
  if (left.lastOpened !== right.lastOpened) {
    if (left.lastOpened === null) return 1;
    if (right.lastOpened === null) return -1;
    return right.lastOpened - left.lastOpened;
  }
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

/**
 * Merges local recents, live hosted vaults and offline-only replicas into one
 * list, most recently opened first. A hosted vault that also has an offline copy
 * appears once, as hosted, carrying the copy's pending-change count.
 */
export function buildVaultEntries({
  recentVaults,
  connections,
  replicas,
  hostedLastOpened,
}: {
  recentVaults: VaultMeta[];
  connections: Record<string, ServerConnection>;
  replicas: ReplicaSummary[];
  hostedLastOpened: Record<string, number>;
}): VaultEntry[] {
  const entries: VaultEntry[] = [];
  const replicaByKey = new Map(
    replicas.map((replica) => [
      hostedVaultActivityKey(replica.serverUrl, replica.vaultId),
      replica,
    ]),
  );

  for (const vault of recentVaults) {
    if (vaultKind(vault) !== 'local') continue;
    entries.push({
      key: `local|${vault.path}`,
      kind: 'local',
      name: vault.name,
      location: vault.path,
      serverUrl: null,
      detail: 'This device',
      lastOpened: vault.lastOpened > 0 ? vault.lastOpened : null,
      pendingCount: 0,
      local: vault,
    });
  }

  const liveKeys = new Set<string>();
  for (const { status, hostedVaults } of listedConnections(connections)) {
    const serverUrl = status.serverUrl;
    for (const vault of hostedVaults) {
      if (vault.status !== 'active') continue;
      const key = hostedVaultActivityKey(serverUrl, vault.id);
      liveKeys.add(key);
      const replica = replicaByKey.get(key);
      const members = `${vault.members} member${vault.members === 1 ? '' : 's'}`;
      entries.push({
        key: `hosted|${key}`,
        kind: 'hosted',
        name: vault.name,
        location: serverHost(serverUrl),
        serverUrl,
        detail: `${roleLabel(vault.role)} · ${members}`,
        lastOpened: hostedLastOpened[key] ?? null,
        pendingCount: replica?.pendingCount ?? 0,
        hosted: vault,
        replica,
      });
    }
  }

  for (const [key, replica] of replicaByKey) {
    if (liveKeys.has(key)) continue;
    entries.push({
      key: `offline|${key}`,
      kind: 'offline',
      name: replica.vaultName,
      location: serverHost(replica.serverUrl),
      serverUrl: replica.serverUrl,
      detail: `${roleLabel(replicaRole(replica))} · offline copy`,
      lastOpened: hostedLastOpened[key] ?? null,
      pendingCount: replica.pendingCount,
      replica,
    });
  }

  return entries.sort(compareEntries);
}

/**
 * Every server the user has a relationship with: live connections, saved
 * servers without a session, and servers known only from offline copies.
 */
export function buildServerEntries({
  connections,
  knownServers,
  entries,
  now = Date.now(),
}: {
  connections: Record<string, ServerConnection>;
  knownServers: KnownServer[];
  entries: VaultEntry[];
  now?: number;
}): ServerEntry[] {
  const servers = new Map<string, ServerEntry>();
  const ensure = (serverUrl: string, state: ServerEntryState): ServerEntry => {
    let server = servers.get(serverUrl);
    if (!server) {
      server = {
        serverUrl,
        host: serverHost(serverUrl),
        state,
        account: null,
        canCreate: false,
        vaultCount: 0,
        offlineCount: 0,
        known: null,
      };
      servers.set(serverUrl, server);
    }
    return server;
  };

  for (const { status } of listedConnections(connections)) {
    const server = ensure(status.serverUrl, 'connected');
    server.account = status.user?.displayName ?? status.user?.username ?? null;
    server.canCreate = isEffectivelyConnected(status, now);
  }
  for (const known of knownServers) {
    const server = ensure(known.serverUrl, 'signed-out');
    server.known = known;
    server.account ??= known.username || null;
  }
  for (const entry of entries) {
    if (!entry.serverUrl) continue;
    const server = ensure(entry.serverUrl, 'offline-only');
    if (entry.kind === 'offline') server.offlineCount += 1;
    else server.vaultCount += 1;
  }

  const order: Record<ServerEntryState, number> = {
    connected: 0,
    'signed-out': 1,
    'offline-only': 2,
  };
  return Array.from(servers.values()).sort(
    (left, right) => order[left.state] - order[right.state] || left.host.localeCompare(right.host),
  );
}

export function filterVaultEntries(entries: VaultEntry[], filter: VaultEntryFilter): VaultEntry[] {
  const query = filter.query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filter.kind === 'all' || entry.kind === filter.kind) &&
      (!filter.serverUrl || entry.serverUrl === filter.serverUrl) &&
      (!query ||
        entry.name.toLowerCase().includes(query) ||
        entry.location.toLowerCase().includes(query)),
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatLastOpened(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null) return '—';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return 'Yesterday';
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function serverStatusLabel(server: ServerEntry): string {
  if (server.state === 'connected') {
    if (!server.canCreate) return 'Session expired';
    return `Connected · ${server.vaultCount} vault${server.vaultCount === 1 ? '' : 's'}`;
  }
  const copies =
    server.offlineCount > 0
      ? ` · ${server.offlineCount} offline cop${server.offlineCount === 1 ? 'y' : 'ies'}`
      : '';
  if (server.state === 'signed-out') return `Signed out${copies}`;
  return `Not saved${copies}`;
}
