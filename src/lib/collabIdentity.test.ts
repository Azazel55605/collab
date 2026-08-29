import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useServerStore } from '../store/serverStore';
import { useVaultStore } from '../store/vaultStore';
import type { HostedVaultMeta, LocalVaultMeta } from '../types/vault';

import { serverIdentityForVault, useCollabIdentity, userColorForId } from './collabIdentity';
import type { ServerConnectionStatus } from './tauri';

const hostedVault: HostedVaultMeta = {
  kind: 'hosted',
  id: 'vault-1',
  hostedVaultId: 'vault-1',
  serverUrl: 'https://collab.example.test',
  name: 'Team Vault',
  path: 'hosted://vault-1',
  lastOpened: 1,
  isEncrypted: false,
  role: 'editor',
};

const localVault: LocalVaultMeta = {
  kind: 'local',
  id: 'local-1',
  name: 'Local Vault',
  path: '/vaults/local',
  lastOpened: 1,
  isEncrypted: false,
};

const connectedStatus: ServerConnectionStatus = {
  connected: true,
  serverUrl: 'https://collab.example.test',
  allowInvalidCertificates: false,
  user: {
    id: 'server-user-9',
    username: 'alice',
    displayName: 'Alice Server',
    role: 'member',
    status: 'active',
  },
  accessExpiresAt: '2026-06-11T12:00:00Z',
};

describe('userColorForId', () => {
  it('is deterministic for the same seed', () => {
    expect(userColorForId('abc')).toBe(userColorForId('abc'));
  });

  it('returns a palette color', () => {
    expect(userColorForId('whatever')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('serverIdentityForVault', () => {
  it('returns the server user for a hosted vault on the matching server', () => {
    expect(serverIdentityForVault(hostedVault, connectedStatus)).toEqual({
      userId: 'server-user-9',
      userName: 'Alice Server',
      userColor: userColorForId('server-user-9'),
      source: 'server',
    });
  });

  it('returns null for a local vault', () => {
    expect(serverIdentityForVault(localVault, connectedStatus)).toBeNull();
  });

  it('returns null when the connected server does not match the vault server', () => {
    expect(
      serverIdentityForVault(hostedVault, {
        ...connectedStatus,
        serverUrl: 'https://other.example.test',
      }),
    ).toBeNull();
  });

  it('returns null when not connected', () => {
    expect(
      serverIdentityForVault(hostedVault, { ...connectedStatus, connected: false }),
    ).toBeNull();
  });

  it('returns null when no vault is open', () => {
    expect(serverIdentityForVault(null, connectedStatus)).toBeNull();
  });
});

describe('useCollabIdentity', () => {
  beforeEach(() => {
    useVaultStore.setState({ vault: null } as never);
    useServerStore.setState({ connections: {} } as never);
    useCollabStore.setState({
      myUserId: 'local-uuid',
      myUserName: 'Local Name',
      myUserColor: '#123456',
    } as never);
  });

  it('falls back to the local client identity', () => {
    const { result } = renderHook(() => useCollabIdentity());
    expect(result.current).toEqual({
      userId: 'local-uuid',
      userName: 'Local Name',
      userColor: '#123456',
      source: 'local',
    });
  });

  it('uses the local identity for local vaults even while connected', () => {
    useVaultStore.setState({ vault: localVault } as never);
    useServerStore.setState({
      connections: { [connectedStatus.serverUrl!]: { status: connectedStatus, hostedVaults: [] } },
    } as never);
    const { result } = renderHook(() => useCollabIdentity());
    expect(result.current.source).toBe('local');
    expect(result.current.userId).toBe('local-uuid');
  });

  it('uses the server identity for the matching hosted vault', () => {
    useVaultStore.setState({ vault: hostedVault } as never);
    useServerStore.setState({
      connections: { [connectedStatus.serverUrl!]: { status: connectedStatus, hostedVaults: [] } },
    } as never);
    const { result } = renderHook(() => useCollabIdentity());
    expect(result.current.source).toBe('server');
    expect(result.current.userId).toBe('server-user-9');
    expect(result.current.userName).toBe('Alice Server');
  });
});
