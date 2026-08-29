import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import { CollabProvider } from './CollabProvider';

const transportMocks = vi.hoisted(() => ({
  broadcastPresence: vi.fn(async () => {}),
  readPresence: vi.fn(async () => []),
  clearPresence: vi.fn(async () => {}),
  sendChatMessage: vi.fn(async () => {}),
  readChatMessages: vi.fn(async () => []),
  readVaultConfig: vi.fn(async () => ({
    id: 'config-1',
    name: 'Vault',
    knownUsers: [],
    owner: 'user-1',
    members: [],
  })),
  onPresenceChanged: vi.fn(() => () => {}),
  onChatUpdated: vi.fn(() => () => {}),
  onConfigChanged: vi.fn(() => () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  getAppVersion: vi.fn(async () => '1.2.3'),
  tauriCommands: {
    registerKnownUser: vi.fn(async () => ({
      id: 'config-1',
      name: 'Vault',
      knownUsers: [],
      owner: 'user-1',
      members: [],
    })),
  },
}));

vi.mock('../../lib/collabTransport', () => {
  class FileSystemTransport {
    constructor(_vaultPath: string) {}
    broadcastPresence = transportMocks.broadcastPresence;
    readPresence = transportMocks.readPresence;
    clearPresence = transportMocks.clearPresence;
    sendChatMessage = transportMocks.sendChatMessage;
    readChatMessages = transportMocks.readChatMessages;
    readVaultConfig = transportMocks.readVaultConfig;
    onPresenceChanged = transportMocks.onPresenceChanged;
    onChatUpdated = transportMocks.onChatUpdated;
    onConfigChanged = transportMocks.onConfigChanged;
  }

  return {
    FileSystemTransport,
    createCollabTransport: vi.fn(() => new FileSystemTransport('/vault')),
  };
});

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('CollabProvider presence lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useVaultStore.setState({
      vault: {
        id: 'vault-1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      lastOpenedVaultPath: '/vault',
      isLoading: false,
      refreshFileTree: vi.fn(async () => {}),
      openVault: vi.fn(async () => {}),
      unlockVault: vi.fn(async () => {}),
      closeVault: vi.fn(),
      loadRecentVaults: vi.fn(async () => {}),
      removeRecentVault: vi.fn(async () => {}),
    });

    useEditorStore.setState({
      sessionVaultPath: '/vault',
      openTabs: [],
      activeTabPath: 'Notes/a.md',
      forceReloadPath: null,
    });

    useUiStore.setState({
      activeView: 'editor',
      sidebarPanel: 'files',
      collabTab: 'peers',
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });
    useServerStore.setState({ connections: {} } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('does not clear presence when chat visibility changes, only on unmount', async () => {
    const view = render(
      <CollabProvider>
        <div>child</div>
      </CollabProvider>,
    );

    await waitFor(() => {
      expect(transportMocks.broadcastPresence).toHaveBeenCalled();
    });

    useUiStore.setState({ sidebarPanel: 'collab', collabTab: 'chat' });
    useUiStore.setState({ isSidebarOpen: false });
    useUiStore.setState({ isSidebarOpen: true, sidebarPanel: 'files', collabTab: 'peers' });

    await Promise.resolve();
    expect(transportMocks.clearPresence).not.toHaveBeenCalled();

    view.unmount();

    await waitFor(() => {
      expect(transportMocks.clearPresence).toHaveBeenCalledTimes(1);
      expect(transportMocks.clearPresence).toHaveBeenCalledWith('user-1');
    });
  });

  it('registers local identity without claiming local ownership', async () => {
    render(
      <CollabProvider>
        <div>child</div>
      </CollabProvider>,
    );

    await waitFor(() => {
      expect(tauriCommands.registerKnownUser).toHaveBeenCalledWith(
        '/vault',
        'user-1',
        'Test User',
        '#22c55e',
      );
    });
    expect(transportMocks.onConfigChanged).not.toHaveBeenCalled();
  });

  it('broadcasts hosted presence with the authenticated server identity', async () => {
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault-1',
        hostedVaultId: 'hosted-vault-1',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        path: 'hosted://hosted-vault-1',
        name: 'Hosted Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
    });
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
              username: 'server-user',
              displayName: 'Server User',
              role: 'member',
              status: 'active',
            },
            accessExpiresAt: '2026-06-17T12:00:00Z',
          },
        },
      },
    } as never);

    render(
      <CollabProvider>
        <div>child</div>
      </CollabProvider>,
    );

    expect(tauriCommands.registerKnownUser).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(transportMocks.broadcastPresence).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'server-user-1',
          userName: 'Server User',
          activeFile: 'Notes/a.md',
        }),
      );
    });
  });
});
