import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import VaultPicker from './VaultPicker';

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    showOpenVaultDialog: vi.fn(),
    reauthenticateServer: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const replicaMock = vi.hoisted(() => ({
  listHostedVaultReplicas: vi.fn(),
  deleteHostedVaultReplica: vi.fn(),
}));

vi.mock('../../lib/vaultReplica', () => ({
  listHostedVaultReplicas: replicaMock.listHostedVaultReplicas,
  deleteHostedVaultReplica: replicaMock.deleteHostedVaultReplica,
}));

const hostedVault = {
  id: 'vault-1',
  name: 'Team Vault',
  ownerUserId: 'user-1',
  ownerDisplayName: 'Alice',
  role: 'editor' as const,
  status: 'active' as const,
  manifestSequence: 1,
  members: 3,
  storageBytes: 100,
  createdAt: '2026-06-11T08:00:00Z',
  updatedAt: '2026-06-11T09:00:00Z',
};

describe('VaultPicker hosted vaults', () => {
  const openHostedVault = vi.fn(async () => {});
  const createHostedVault = vi.fn(async () => hostedVault);
  const disconnect = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    replicaMock.listHostedVaultReplicas.mockResolvedValue([]);
    replicaMock.deleteHostedVaultReplica.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    useVaultStore.setState({
      vault: null,
      recentVaults: [],
      isLoading: false,
      openVault: vi.fn(async () => {}),
      openHostedVault,
      loadRecentVaults: vi.fn(async () => {}),
    });
    useServerStore.setState({
      connections: {
        'https://collab.example.test': {
          status: {
            connected: true,
            serverUrl: 'https://collab.example.test',
            allowInvalidCertificates: false,
            user: { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'member', status: 'active' },
            accessExpiresAt: '2999-01-01T00:00:00Z',
          },
          hostedVaults: [hostedVault],
        },
      },
      isLoading: false,
      error: null,
      refreshAll: vi.fn(async () => {}),
      loadHostedVaults: vi.fn(async () => {}),
      createHostedVault,
      disconnect,
    } as never);
  });

  it('opens a listed hosted vault with server-backed metadata', async () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: /Team Vault/ }));

    await waitFor(() => expect(openHostedVault).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hosted',
      hostedVaultId: 'vault-1',
      serverUrl: 'https://collab.example.test',
      role: 'editor',
      path: 'hosted://vault-1',
    })));
  });

  it('keeps branding outside a bounded scrollable vault inventory', () => {
    render(<VaultPicker />);

    const inventory = screen.getByRole('region', { name: 'Vaults and servers' });
    expect(inventory.className).toContain('overflow-y-auto');
    expect(inventory.contains(screen.getByRole('heading', { name: 'collab' }))).toBe(false);
    expect(inventory.contains(screen.getByRole('button', { name: /Team Vault/ }))).toBe(true);
  });

  it('creates a hosted vault and opens it', async () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByTitle('New hosted vault'));
    fireEvent.change(screen.getByPlaceholderText('New hosted vault name'), { target: { value: 'Fresh Vault' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createHostedVault).toHaveBeenCalledWith('https://collab.example.test', 'Fresh Vault'));
    await waitFor(() => expect(openHostedVault).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hosted',
      hostedVaultId: 'vault-1',
    })));
  });

  it('reveals an inline hosted login form when disconnected', async () => {
    useServerStore.setState({
      connections: {},
    });

    render(<VaultPicker />);
    // The form is collapsed behind a prompt until the user opts in.
    expect(screen.queryByLabelText('Server URL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Connect a Collab server/ }));

    await waitFor(() => expect(screen.getByLabelText('Server URL')).toBeTruthy());
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('offers password-only sign in for a saved disconnected server', () => {
    localStorage.setItem('collab-hosted-servers', JSON.stringify([{
      serverUrl: 'https://saved.example.test',
      username: 'alice',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
    }]));
    useServerStore.setState({ connections: {} });

    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(screen.getByText(/alice on https:\/\/saved\.example\.test/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Server URL')).toBeNull();
  });

  it('lists offline hosted vault copies when disconnected and opens the cached replica', async () => {
    replicaMock.listHostedVaultReplicas.mockResolvedValue([
      {
        serverUrl: 'https://server-one.test',
        vaultId: 'vault-offline-1',
        vaultName: 'Offline One',
        manifestSequence: 4,
        lastSyncedAt: '2026-06-21T10:00:00Z',
        status: 'offline',
        pendingCount: 2,
        updatedAt: '2026-06-21T10:00:00Z',
        role: 'editor',
        capabilities: ['vault.read', 'file.write'],
      },
      {
        serverUrl: 'https://server-two.test',
        vaultId: 'vault-offline-2',
        vaultName: 'Offline Two',
        manifestSequence: 8,
        lastSyncedAt: null,
        status: 'idle',
        pendingCount: 0,
        updatedAt: '2026-06-20T10:00:00Z',
        role: 'admin',
        capabilities: ['vault.read'],
      },
    ]);
    useServerStore.setState({
      connections: {},
    });

    render(<VaultPicker />);

    expect(await screen.findByText('Offline copies · https://server-one.test')).toBeTruthy();
    expect(screen.getByText('Offline copies · https://server-two.test')).toBeTruthy();
    fireEvent.click(screen.getAllByTitle('Open offline copy')[0]);

    await waitFor(() => expect(openHostedVault).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hosted',
      hostedVaultId: 'vault-offline-1',
      serverUrl: 'https://server-one.test',
      role: 'editor',
      capabilities: ['vault.read', 'file.write'],
    })));
  });

  it('removes an offline hosted vault copy from a stale server', async () => {
    const staleReplica = {
      serverUrl: 'https://dead-server.test',
      vaultId: 'vault-stale',
      vaultName: 'Stale Offline',
      manifestSequence: 4,
      lastSyncedAt: null,
      status: 'idle',
      pendingCount: 0,
      updatedAt: '2026-06-20T10:00:00Z',
      role: 'viewer',
      capabilities: [],
    };
    replicaMock.listHostedVaultReplicas
      .mockResolvedValueOnce([staleReplica])
      .mockResolvedValueOnce([]);
    useServerStore.setState({
      connections: {},
    });

    render(<VaultPicker />);
    expect(await screen.findByText('Stale Offline')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove offline copy Stale Offline'));

    await waitFor(() => expect(replicaMock.deleteHostedVaultReplica).toHaveBeenCalledWith(staleReplica));
    await waitFor(() => expect(screen.queryByText('Stale Offline')).toBeNull());
  });

  it('logs out of the connected server through the disconnect control', async () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByTitle('Log out of server'));
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
  });
});
