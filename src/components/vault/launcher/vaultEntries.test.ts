import { describe, expect, it } from 'vitest';

import type { ReplicaSummary } from '../../../lib/vaultReplica';
import type { ServerConnection } from '../../../store/serverStore';
import type { HostedVaultSummary, VaultMeta } from '../../../types/vault';

import {
  buildServerEntries,
  buildVaultEntries,
  filterVaultEntries,
  formatLastOpened,
  serverHost,
} from './vaultEntries';

const SERVER = 'https://collab.example.test';
const OTHER = 'https://other.example.test';

function hosted(id: string, name: string, extra: Partial<HostedVaultSummary> = {}) {
  return {
    id,
    name,
    ownerUserId: 'u1',
    ownerDisplayName: 'Alice',
    role: 'editor',
    status: 'active',
    manifestSequence: 1,
    members: 3,
    storageBytes: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  } as HostedVaultSummary;
}

function connection(serverUrl: string, vaults: HostedVaultSummary[]): ServerConnection {
  return {
    status: {
      connected: true,
      serverUrl,
      allowInvalidCertificates: false,
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        role: 'member',
        status: 'active',
      },
      accessExpiresAt: '2999-01-01T00:00:00Z',
    },
    hostedVaults: vaults,
  };
}

function replica(serverUrl: string, vaultId: string, extra: Partial<ReplicaSummary> = {}) {
  return {
    serverUrl,
    vaultId,
    vaultName: `Copy ${vaultId}`,
    manifestSequence: 1,
    lastSyncedAt: null,
    status: 'idle',
    pendingCount: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    role: 'editor',
    capabilities: [],
    ...extra,
  } as ReplicaSummary;
}

const local = (name: string, lastOpened: number): VaultMeta => ({
  id: name,
  name,
  path: `/home/me/${name}`,
  lastOpened,
  isEncrypted: false,
});

describe('buildVaultEntries', () => {
  it('merges local, hosted and offline-only vaults, most recently opened first', () => {
    const entries = buildVaultEntries({
      recentVaults: [
        local('Notes', 1_000),
        { ...local('Hosted ghost', 9_000), kind: 'hosted' } as VaultMeta,
      ],
      connections: { [SERVER]: connection(SERVER, [hosted('h1', 'Team')]) },
      replicas: [replica(OTHER, 'r1', { pendingCount: 2 })],
      hostedLastOpened: { [`${SERVER}|h1`]: 5_000 },
    });

    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ['hosted', 'Team'],
      ['local', 'Notes'],
      ['offline', 'Copy r1'],
    ]);
    expect(entries[0]).toMatchObject({
      location: 'collab.example.test',
      detail: 'Editor · 3 members',
    });
    expect(entries[2]).toMatchObject({
      pendingCount: 2,
      lastOpened: null,
      detail: 'Editor · offline copy',
    });
  });

  it('shows a hosted vault with an offline copy once, carrying its pending count', () => {
    const entries = buildVaultEntries({
      recentVaults: [],
      connections: { [SERVER]: connection(SERVER, [hosted('h1', 'Team')]) },
      replicas: [replica(SERVER, 'h1', { pendingCount: 4 })],
      hostedLastOpened: {},
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'hosted', pendingCount: 4 });
  });

  it('skips archived hosted vaults', () => {
    const entries = buildVaultEntries({
      recentVaults: [],
      connections: {
        [SERVER]: connection(SERVER, [hosted('h1', 'Old', { status: 'archived' })]),
      },
      replicas: [],
      hostedLastOpened: {},
    });
    expect(entries).toEqual([]);
  });
});

describe('buildServerEntries', () => {
  it('lists connected, signed-out and offline-only servers in that order', () => {
    const entries = buildVaultEntries({
      recentVaults: [],
      connections: { [SERVER]: connection(SERVER, [hosted('h1', 'Team')]) },
      replicas: [replica('https://stale.test', 'r1'), replica(OTHER, 'r2')],
      hostedLastOpened: {},
    });
    const servers = buildServerEntries({
      connections: { [SERVER]: connection(SERVER, [hosted('h1', 'Team')]) },
      knownServers: [
        {
          serverUrl: OTHER,
          username: 'bob',
          allowInvalidCertificates: false,
          persistAcrossReboots: true,
        },
      ],
      entries,
      now: 0,
    });

    expect(servers.map((server) => [server.host, server.state])).toEqual([
      ['collab.example.test', 'connected'],
      ['other.example.test', 'signed-out'],
      ['stale.test', 'offline-only'],
    ]);
    expect(servers[0]).toMatchObject({ account: 'Alice', canCreate: true, vaultCount: 1 });
    expect(servers[1]).toMatchObject({ account: 'bob', offlineCount: 1, canCreate: false });
  });
});

describe('filterVaultEntries', () => {
  const entries = buildVaultEntries({
    recentVaults: [local('Notes', 1)],
    connections: { [SERVER]: connection(SERVER, [hosted('h1', 'Team')]) },
    replicas: [replica(OTHER, 'r1')],
    hostedLastOpened: {},
  });

  it('combines kind, server and text filters', () => {
    const names = (filter: Parameters<typeof filterVaultEntries>[1]) =>
      filterVaultEntries(entries, filter).map((entry) => entry.name);

    expect(names({ kind: 'all', serverUrl: null, query: '' })).toHaveLength(3);
    expect(names({ kind: 'local', serverUrl: null, query: '' })).toEqual(['Notes']);
    expect(names({ kind: 'all', serverUrl: OTHER, query: '' })).toEqual(['Copy r1']);
    expect(names({ kind: 'all', serverUrl: null, query: 'collab.example' })).toEqual(['Team']);
    expect(names({ kind: 'hosted', serverUrl: OTHER, query: '' })).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats relative last-opened times', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(formatLastOpened(null, now)).toBe('—');
    expect(formatLastOpened(now - 10_000, now)).toBe('Just now');
    expect(formatLastOpened(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatLastOpened(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatLastOpened(now - 30 * 3_600_000, now)).toBe('Yesterday');
    expect(formatLastOpened(now - 4 * 86_400_000, now)).toBe('4 days ago');
  });

  it('extracts the host from a server URL', () => {
    expect(serverHost('https://collab.example.test:8443')).toBe('collab.example.test:8443');
    expect(serverHost('not a url')).toBe('not a url');
  });
});
