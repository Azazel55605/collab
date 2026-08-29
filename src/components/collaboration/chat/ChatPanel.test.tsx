import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../../lib/tauri';
import { useCollabStore } from '../../../store/collabStore';
import { useServerStore } from '../../../store/serverStore';
import { useVaultStore } from '../../../store/vaultStore';
import type { HostedVaultMeta, LocalVaultMeta } from '../../../types/vault';

import { ChatPanel } from './ChatPanel';

vi.mock('../../../lib/tauri', () => ({
  tauriCommands: {
    sendChatMessage: vi.fn(),
    readChatMessages: vi.fn(),
    hostedVaultRequest: vi.fn(),
  },
}));

const localVault: LocalVaultMeta = {
  kind: 'local',
  id: 'local-1',
  name: 'Local',
  path: '/vaults/local',
  lastOpened: 1,
  isEncrypted: false,
};

const hostedVault: HostedVaultMeta = {
  kind: 'hosted',
  id: 'vault-1',
  hostedVaultId: 'vault-1',
  serverUrl: 'https://collab.example.test',
  name: 'Hosted',
  path: 'hosted://vault-1',
  lastOpened: 1,
  isEncrypted: false,
  role: 'admin',
};

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vault: localVault } as never);
    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    } as never);
    useServerStore.setState({ connections: {}, isLoading: false, error: null } as never);
  });

  it('renders the composer for local (filesystem-backed) vaults', () => {
    render(<ChatPanel />);
    expect(screen.getByPlaceholderText(/Message/)).not.toBeNull();
  });

  it('renders the composer for hosted vaults', () => {
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<ChatPanel />);
    expect(screen.getByPlaceholderText(/Message/)).not.toBeNull();
    expect(screen.queryByText(/Chat isn't available for hosted vaults/)).toBeNull();
  });

  it('sends hosted chat through the authenticated vault gateway', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '019eb16e-2a85-7070-bbe7-8cf09911c2c1' });
    useVaultStore.setState({ vault: hostedVault } as never);
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({
      id: '019eb16e-2a85-7070-bbe7-8cf09911c2c1',
      userId: 'user-1',
      userName: 'Test User',
      userColor: '#22c55e',
      content: 'Hello hosted',
      timestamp: 1,
    });

    render(<ChatPanel />);
    fireEvent.change(screen.getByPlaceholderText(/Message/), { target: { value: 'Hello hosted' } });
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
        'https://collab.example.test',
        'POST',
        '/api/v1/vaults/vault-1/chat',
        { id: '019eb16e-2a85-7070-bbe7-8cf09911c2c1', content: 'Hello hosted' },
      );
    });
  });

  it('treats echoed hosted messages from the authenticated server user as self', () => {
    useVaultStore.setState({ vault: hostedVault } as never);
    useServerStore.setState({
      connections: {
        'https://collab.example.test': {
          hostedVaults: [],
          status: {
            connected: true,
            serverUrl: 'https://collab.example.test',
            allowInvalidCertificates: false,
            user: {
              id: 'server-user-1',
              username: 'admin',
              displayName: 'Hosted Admin',
              role: 'admin',
              status: 'active',
              createdAt: '2026-06-17T00:00:00Z',
              lastLoginAt: null,
              activeSessions: 1,
              isPrimaryAdmin: true,
            },
            accessExpiresAt: '2999-01-01T00:00:00Z',
          },
        },
      },
    } as never);
    useCollabStore.setState({
      chatMessages: [
        {
          id: 'message-1',
          userId: 'server-user-1',
          userName: 'Hosted Admin',
          userColor: '#8b5cf6',
          content: 'Still me after polling',
          timestamp: 1,
        },
      ],
    } as never);

    render(<ChatPanel />);

    expect(screen.getByText('Still me after polling')).not.toBeNull();
    expect(screen.queryByText('Hosted Admin')).toBeNull();
  });
});
