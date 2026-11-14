import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';
import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import VaultPicker from './VaultPicker';

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    showOpenVaultDialog: vi.fn(),
    reauthenticateServer: vi.fn(),
    createVault: vi.fn(),
    showSaveDialog: vi.fn(),
    exportVault: vi.fn(),
  },
}));

const syncMock = vi.hoisted(() => ({ makeAvailableOffline: vi.fn() }));
vi.mock('../../store/syncStore', () => ({
  useSyncStore: { getState: () => ({ makeAvailableOffline: syncMock.makeAvailableOffline }) },
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

const SERVER = 'https://collab.example.test';

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

const localVault = {
  id: 'local-1',
  name: 'Personal Notes',
  path: '/home/me/notes',
  lastOpened: Date.now() - 60 * 60 * 1000,
  isEncrypted: false,
};

function offlineReplica(serverUrl: string, vaultId: string, vaultName: string, pendingCount = 0) {
  return {
    serverUrl,
    vaultId,
    vaultName,
    manifestSequence: 4,
    lastSyncedAt: null,
    status: 'idle',
    pendingCount,
    updatedAt: '2026-06-20T10:00:00Z',
    role: 'editor',
    capabilities: ['vault.read', 'file.write'],
  };
}

function saveKnownServer(serverUrl: string, username = 'alice') {
  localStorage.setItem(
    'collab-hosted-servers',
    JSON.stringify([
      { serverUrl, username, allowInvalidCertificates: false, persistAcrossReboots: true },
    ]),
  );
}

function openRowMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${name}` }), {
    key: 'Enter',
  });
}

describe('VaultPicker start screen', () => {
  const openVault = vi.fn(async () => {});
  const openHostedVault = vi.fn(async () => {});
  const removeRecentVault = vi.fn(async () => {});
  const createHostedVault = vi.fn(async () => hostedVault);
  const disconnect = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    replicaMock.listHostedVaultReplicas.mockResolvedValue([]);
    replicaMock.deleteHostedVaultReplica.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    useUiStore.setState({ activeView: 'editor' } as never);
    useVaultStore.setState({
      vault: null,
      recentVaults: [localVault],
      isLoading: false,
      openVault,
      openHostedVault,
      removeRecentVault,
      loadRecentVaults: vi.fn(async () => {}),
    });
    useServerStore.setState({
      connections: {
        [SERVER]: {
          status: {
            connected: true,
            serverUrl: SERVER,
            allowInvalidCertificates: false,
            user: {
              id: 'user-1',
              username: 'alice',
              displayName: 'Alice',
              role: 'member',
              status: 'active',
            },
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

  it('lists local and hosted vaults in one list and opens a hosted vault', async () => {
    render(<VaultPicker />);
    const list = screen.getByRole('list', { name: 'Vaults' });
    expect(within(list).getByRole('button', { name: 'Personal Notes' })).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Team Vault' }));

    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'hosted',
          hostedVaultId: 'vault-1',
          serverUrl: SERVER,
          role: 'editor',
          path: 'hosted://vault-1',
        }),
      ),
    );
  });

  it('shows recently opened vaults as cards', () => {
    render(<VaultPicker />);
    const recent = screen.getByRole('region', { name: 'Jump back in' });
    fireEvent.click(within(recent).getByRole('button', { name: /Personal Notes/ }));
    expect(openVault).toHaveBeenCalledWith('/home/me/notes');
  });

  it('navigates to chats and databases from the rail', () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(useUiStore.getState().activeView).toBe('chats');
    fireEvent.click(screen.getByRole('button', { name: 'Databases' }));
    expect(useUiStore.getState().activeView).toBe('databases');
  });

  it('filters the list by kind and by search, and opens the highlighted match with Enter', () => {
    render(<VaultPicker />);
    const list = screen.getByRole('list', { name: 'Vaults' });

    fireEvent.click(screen.getByRole('button', { name: /^This device/ }));
    expect(within(list).queryByRole('button', { name: 'Team Vault' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));

    const search = screen.getByRole('searchbox', { name: 'Search vaults' });
    fireEvent.change(search, { target: { value: 'team' } });
    expect(within(list).queryByRole('button', { name: 'Personal Notes' })).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(openHostedVault).toHaveBeenCalledWith(
      expect.objectContaining({ hostedVaultId: 'vault-1' }),
    );
  });

  it('filters to one server when its rail entry is clicked', () => {
    render(<VaultPicker />);
    const list = screen.getByRole('list', { name: 'Vaults' });
    const serverButton = screen.getByRole('button', {
      name: /collab\.example\.test/,
      pressed: false,
    });

    fireEvent.click(serverButton);
    expect(serverButton.getAttribute('aria-pressed')).toBe('true');
    expect(within(list).queryByRole('button', { name: 'Personal Notes' })).toBeNull();
    expect(within(list).getByRole('button', { name: 'Team Vault' })).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear server filter collab.example.test' }),
    );
    expect(within(list).getByRole('button', { name: 'Personal Notes' })).toBeTruthy();
  });

  it('logs out through the server details dialog', async () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Details for collab.example.test' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Alice')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(SERVER));
  });

  it('creates a hosted vault from the server details dialog and opens it', async () => {
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Details for collab.example.test' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New hosted vault' }));

    const dialog = await screen.findByRole('dialog', { name: 'New vault' });
    expect(
      within(dialog)
        .getByRole('radio', { name: /collab\.example\.test/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fresh Vault' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create vault' }));

    await waitFor(() => expect(createHostedVault).toHaveBeenCalledWith(SERVER, 'Fresh Vault'));
    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'hosted', hostedVaultId: 'vault-1' }),
      ),
    );
  });

  it('creates a local vault in a chosen folder', async () => {
    vi.mocked(tauriCommands.showOpenVaultDialog).mockResolvedValue('/home/me/research');
    vi.mocked(tauriCommands.createVault).mockResolvedValue(undefined as never);
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'New vault' }));

    const dialog = await screen.findByRole('dialog', { name: 'New vault' });
    const create = within(dialog).getByRole('button', { name: 'Create vault' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('research'),
    );
    fireEvent.click(create);

    await waitFor(() =>
      expect(tauriCommands.createVault).toHaveBeenCalledWith(
        '/home/me/research',
        'research',
        undefined,
        undefined,
      ),
    );
    await waitFor(() => expect(openVault).toHaveBeenCalledWith('/home/me/research'));
  });

  it('shows one banner for a signed-out saved server and offers password-only sign in', async () => {
    saveKnownServer('https://saved.example.test');
    useServerStore.setState({ connections: {} });

    render(<VaultPicker />);
    expect(screen.getByRole('status').textContent).toContain('saved.example.test is signed out');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to saved.example.test' }));

    expect(await screen.findByText(/alice on https:\/\/saved\.example\.test/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Server URL')).toBeNull();
  });

  it('lists offline copies as rows with a pending badge and opens the cached replica', async () => {
    replicaMock.listHostedVaultReplicas.mockResolvedValue([
      offlineReplica('https://server-one.test', 'vault-offline-1', 'Offline One', 2),
    ]);
    useServerStore.setState({ connections: {} });

    render(<VaultPicker />);
    const row = await screen.findByRole('button', { name: /^Offline One/ });
    expect(row.textContent).toContain('2 pending');
    fireEvent.click(row);

    await waitFor(() =>
      expect(openHostedVault).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'hosted',
          hostedVaultId: 'vault-offline-1',
          serverUrl: 'https://server-one.test',
          role: 'editor',
          capabilities: ['vault.read', 'file.write'],
        }),
      ),
    );
  });

  it('removes an offline copy from its row menu', async () => {
    const stale = offlineReplica('https://dead-server.test', 'vault-stale', 'Stale Offline');
    replicaMock.listHostedVaultReplicas.mockResolvedValueOnce([stale]).mockResolvedValueOnce([]);
    useServerStore.setState({ connections: {} });

    render(<VaultPicker />);
    await screen.findByRole('button', { name: 'Stale Offline' });
    openRowMenu('Stale Offline');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove offline copy' }));

    await waitFor(() => expect(replicaMock.deleteHostedVaultReplica).toHaveBeenCalledWith(stale));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stale Offline' })).toBeNull());
  });

  it('downloads a local vault as a ZIP from its row', async () => {
    vi.mocked(tauriCommands.showSaveDialog).mockResolvedValue('/tmp/Personal Notes.zip');
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Personal Notes as ZIP' }));
    await waitFor(() =>
      expect(tauriCommands.exportVault).toHaveBeenCalledWith(
        '/home/me/notes',
        '/tmp/Personal Notes.zip',
      ),
    );
    // Editors cannot export hosted vaults, so their rows offer no download.
    expect(screen.queryByRole('button', { name: 'Download Team Vault as ZIP' })).toBeNull();
  });

  it('makes a hosted vault available offline only when the account may copy it', async () => {
    syncMock.makeAvailableOffline.mockResolvedValue({ documentsCached: 4, assetsCached: 1 });
    useServerStore.setState((state) => ({
      connections: {
        [SERVER]: {
          ...state.connections[SERVER],
          hostedVaults: [{ ...hostedVault, capabilities: ['vault.read', 'vault.offlineCopy'] }],
        },
      },
    }));
    render(<VaultPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Make Team Vault available offline' }));
    await waitFor(() =>
      expect(syncMock.makeAvailableOffline).toHaveBeenCalledWith(
        expect.objectContaining({ hostedVaultId: 'vault-1', serverUrl: SERVER }),
      ),
    );
  });

  it('removes a local vault from the list through its row menu', async () => {
    render(<VaultPicker />);
    openRowMenu('Personal Notes');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from list' }));
    await waitFor(() => expect(removeRecentVault).toHaveBeenCalledWith('/home/me/notes'));
  });

  it('shows first-run choices with no vaults or servers, and connects a server', async () => {
    useVaultStore.setState({ recentVaults: [] });
    useServerStore.setState({ connections: {} });

    render(<VaultPicker />);
    expect(screen.getByRole('heading', { name: 'Set up your first vault' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Connect a server/ }));

    expect(await screen.findByLabelText('Server URL')).toBeTruthy();
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });
});
