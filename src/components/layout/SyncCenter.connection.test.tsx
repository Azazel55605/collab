import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConnectionStatus } from '../../lib/tauri';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import type { HostedVaultMeta, LocalVaultMeta } from '../../types/vault';

import SyncCenter from './SyncCenter';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

const connected: ServerConnectionStatus = {
  connected: true,
  serverUrl: 'https://collab.example.test',
  allowInvalidCertificates: false,
  user: { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'member', status: 'active' },
  accessExpiresAt: '2999-01-01T00:00:00Z',
};

const reconnect = vi.fn().mockResolvedValue(undefined);

function setState(
  vault: HostedVaultMeta | LocalVaultMeta | null,
  status: ServerConnectionStatus | null,
) {
  useVaultStore.setState({ vault } as never);
  const connections =
    status?.connected && status.serverUrl
      ? { [status.serverUrl]: { status, hostedVaults: [] } }
      : {};
  useServerStore.setState({ connections, reconnect } as never);
}

describe('SyncCenter connection', () => {
  beforeEach(() => {
    reconnect.mockClear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no connection state for a local vault', () => {
    setState(localVault, null);
    const { container } = render(<SyncCenter />);
    expect(container.firstChild).toBeNull();
  });

  it('shows Online when connected to the matching server with a live token', () => {
    setState(hostedVault, connected);
    render(<SyncCenter />);
    fireEvent.click(screen.getByTitle('Sync status'));
    expect(screen.getByText('Online · signed in as Alice')).not.toBeNull();
  });

  it('shows Session expired when the token has expired', () => {
    setState(hostedVault, { ...connected, accessExpiresAt: '2000-01-01T00:00:00Z' });
    render(<SyncCenter />);
    expect(screen.getByText('Session expired')).not.toBeNull();
  });

  it('shows Offline when disconnected and reconnects on click', async () => {
    setState(hostedVault, { ...connected, connected: false, serverUrl: null, user: null });
    render(<SyncCenter />);
    fireEvent.click(screen.getByText('Offline'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0]);
    await waitFor(() => {
      expect(reconnect).toHaveBeenCalledWith('https://collab.example.test', false);
    });
  });

  it('uses the saved untrusted-certificate preference when reconnecting from a disconnected status', async () => {
    localStorage.setItem(
      'collab-hosted-servers',
      JSON.stringify([
        {
          serverUrl: 'https://collab.example.test',
          username: '',
          allowInvalidCertificates: true,
          persistAcrossReboots: false,
        },
      ]),
    );
    setState(hostedVault, {
      ...connected,
      connected: false,
      serverUrl: null,
      user: null,
      allowInvalidCertificates: false,
    });
    render(<SyncCenter />);
    fireEvent.click(screen.getByText('Offline'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reconnect' })[0]);
    await waitFor(() => {
      expect(reconnect).toHaveBeenCalledWith('https://collab.example.test', true);
    });
  });

  it('treats a connection to a different server as offline', () => {
    setState(hostedVault, { ...connected, serverUrl: 'https://other.example.test' });
    render(<SyncCenter />);
    expect(screen.getByText('Offline')).not.toBeNull();
  });
});
