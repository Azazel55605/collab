import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    deleteNote: vi.fn(),
    moveNoteToTrash: vi.fn(),
    createNote: vi.fn(),
    createFolder: vi.fn(),
    previewRenameMove: vi.fn(),
    renameNote: vi.fn(),
    readNote: vi.fn(),
    listFileReferences: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('./VaultDialogs', () => ({
  ConfirmDeleteDialog: () => null,
  InputDialog: () => null,
  RenameMovePreviewDialog: () => null,
}));

vi.mock('./TrashPanel', () => ({
  default: () => <div data-testid="trash-panel" />,
}));

vi.mock('./FileReferencesPanel', () => ({
  default: () => null,
}));

vi.mock('../ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSeparator: () => null,
}));

vi.mock('../ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import FileTree from './FileTree';

describe('FileTree folder collapse state', () => {
  beforeEach(() => {
    localStorage.clear();

    useVaultStore.setState({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: Date.now() },
      isVaultLocked: false,
      fileTree: [
        {
          relativePath: 'Docs',
          name: 'Docs',
          extension: '',
          modifiedAt: 1,
          size: 0,
          isFolder: true,
          children: [
            {
              relativePath: 'Docs/child.md',
              name: 'child.md',
              extension: 'md',
              modifiedAt: 1,
              size: 10,
              isFolder: false,
            },
          ],
        },
      ],
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
      activeTabPath: null,
      forceReloadPath: null,
    });

    useUiStore.setState({
      activeView: 'editor',
      sidebarPanel: 'files',
      collabTab: 'peers',
      fileTreeCollapsedPaths: [],
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,
      confirmDelete: true,
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

  it('keeps a folder collapsed after remounting', () => {
    const firstRender = render(<FileTree />);

    expect(screen.getByText('child.md')).toBeTruthy();

    fireEvent.click(screen.getByText('Docs'));
    expect(screen.queryByText('child.md')).toBeNull();
    expect(useUiStore.getState().fileTreeCollapsedPaths).toEqual(['Docs']);

    firstRender.unmount();
    render(<FileTree />);

    expect(screen.queryByText('child.md')).toBeNull();
  });
});
