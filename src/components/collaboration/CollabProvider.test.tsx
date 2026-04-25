import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

const transportMocks = vi.hoisted(() => ({
  broadcastPresence: vi.fn(async () => {}),
  readPresence: vi.fn(async () => []),
  clearPresence: vi.fn(async () => {}),
  sendChatMessage: vi.fn(async () => {}),
  readChatMessages: vi.fn(async () => []),
  readVaultConfig: vi.fn(async () => ({ id: 'config-1', name: 'Vault', knownUsers: [], owner: 'user-1', members: [] })),
  createSnapshot: vi.fn(async () => ({ id: 'snap-1', relativePath: 'Notes/a.md', authorId: 'user-1', authorName: 'Test User', timestamp: 1, hash: 'hash-1' })),
  listSnapshots: vi.fn(async () => []),
  readSnapshot: vi.fn(async () => ''),
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
    registerKnownUser: vi.fn(async () => ({ id: 'config-1', name: 'Vault', knownUsers: [], owner: 'user-1', members: [] })),
    claimVaultOwnership: vi.fn(async () => ({ id: 'config-1', name: 'Vault', knownUsers: [], owner: 'user-1', members: [] })),
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
    createSnapshot = transportMocks.createSnapshot;
    listSnapshots = transportMocks.listSnapshots;
    readSnapshot = transportMocks.readSnapshot;
    onPresenceChanged = transportMocks.onPresenceChanged;
    onChatUpdated = transportMocks.onChatUpdated;
    onConfigChanged = transportMocks.onConfigChanged;
  }

  return { FileSystemTransport };
});

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { CollabProvider } from './CollabProvider';

describe('CollabProvider presence lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useVaultStore.setState({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: Date.now() },
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
      myRole: null,
      peers: [],
      conflicts: [],
      chatMessages: [],
      chatTypingUntil: null,
    });
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
});
