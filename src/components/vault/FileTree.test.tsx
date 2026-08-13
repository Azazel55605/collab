import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { startFileDragOut } from '../../lib/dragOut';

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
    showOpenFilesDialog: vi.fn(),
    readNoteAssetDataUrl: vi.fn(),
    resolveVaultFilePath: vi.fn(),
    revealInFileManager: vi.fn(),
    showDownloadDialog: vi.fn(),
    writeDownloadedFile: vi.fn(),
  },
}));

vi.mock('../../lib/dragOut', () => ({
  startFileDragOut: vi.fn(async () => {}),
  nativeVaultPath: (root: string, rel: string) => `${root}/${rel}`,
}));

// Radix menus need a real pointer stack to open; the repo's precedent
// (`CanvasToolbar.test.tsx`) is to render the primitives inline instead.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" role="menuitem" onClick={onClick}>{children}</button>
  ),
  DropdownMenuSeparator: () => null,
}));

vi.mock('./useNativeFileDrop', () => ({
  useNativeFileDrop: () => ({ isDraggingOver: false }),
}));

const importExternalFilesIntoVault = vi.fn(
  async (..._args: unknown[]) => ({ imported: ['Pictures/cat.png'], failed: [] as { name: string; error: string }[] }),
);
vi.mock('../../lib/vaultFileImport', () => ({
  importExternalFilesIntoVault: (...args: unknown[]) => importExternalFilesIntoVault(...args),
  IMPORTABLE_EXTENSIONS: ['png', 'pdf', 'md', 'canvas', 'kanban'],
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

vi.mock('../previews/FileTreeHoverPreviewPopover', () => ({
  FileTreeHoverPreviewPopover: ({ relativePath, type, enabled }: { relativePath: string | null; type: string | null; enabled: boolean }) => (
    enabled && relativePath && type ? <div data-testid="file-hover-preview">{`${type}:${relativePath}`}</div> : null
  ),
}));

vi.mock('../collaboration/history/VersionHistoryModal', () => ({
  VersionHistoryModal: ({ open, relativePath }: { open: boolean; relativePath: string | null }) => (
    open && relativePath ? <div data-testid="version-history-modal">{relativePath}</div> : null
  ),
}));

vi.mock('../ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button type="button" onClick={onClick} className={className}>{children}</button>
  ),
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

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ''),
  };
}

describe('FileTree folder collapse state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(tauriCommands.listFileReferences).mockResolvedValue([]);

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
      fileTreeCollapsedPathsByVault: {},
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,
      confirmDelete: true,
      fileTreeHoverPreviewsEnabled: true,
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers every document type from one create menu', () => {
    // The header used to grow an icon button per document type; a header is
    // not the place to keep a list.
    render(<FileTree />);
    const menu = screen.getByRole('menu');

    for (const label of ['New note', 'New spreadsheet', 'New drawing', 'New logic diagram', 'New folder']) {
      expect(within(menu).getByText(label)).toBeTruthy();
    }
    // And exactly one create control in the header, not one per type.
    expect(screen.getByLabelText('Create')).toBeTruthy();
  });

  it('routes each menu item to its own creation dialog', () => {
    render(<FileTree />);
    const menu = screen.getByRole('menu');

    // `NewDrawingDialog` is the one creation surface not stubbed here, so it
    // proves the menu item reaches the right dialog rather than a generic one.
    fireEvent.click(within(menu).getByText('New drawing'));
    expect(screen.getByText('Choose the paper now — every part of it stays editable later.')).toBeTruthy();
  });

  it('keeps a folder collapsed after remounting', () => {
    const firstRender = render(<FileTree />);

    expect(screen.getByText('child.md')).toBeTruthy();

    fireEvent.click(screen.getByText('Docs'));
    expect(screen.queryByText('child.md')).toBeNull();
    expect(useUiStore.getState().fileTreeCollapsedPathsByVault['/vault']).toEqual(['Docs']);

    firstRender.unmount();
    render(<FileTree />);

    expect(screen.queryByText('child.md')).toBeNull();
  });

  it('shows a PDF hover preview when enabled', () => {
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        {
          relativePath: 'Docs/spec.pdf',
          name: 'spec.pdf',
          extension: 'pdf',
          modifiedAt: 1,
          size: 10,
          isFolder: false,
        },
      ],
    });

    render(<FileTree />);

    fireEvent.mouseEnter(screen.getByText('spec.pdf'));

    expect(screen.getByTestId('file-hover-preview').textContent).toBe('pdf:Docs/spec.pdf');
  });

  it('shows an image hover preview when enabled', () => {
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        {
          relativePath: 'Pictures/demo.png',
          name: 'demo.png',
          extension: 'png',
          modifiedAt: 1,
          size: 10,
          isFolder: false,
        },
      ],
    });

    render(<FileTree />);

    fireEvent.mouseEnter(screen.getByText('demo.png'));

    expect(screen.getByTestId('file-hover-preview').textContent).toBe('image:Pictures/demo.png');
  });

  it('downloads a file via the save dialog and write command', async () => {
    vi.mocked(tauriCommands.readNoteAssetDataUrl).mockResolvedValue('data:text/markdown;base64,QUJD');
    vi.mocked(tauriCommands.showDownloadDialog).mockResolvedValue('/home/u/Downloads/child.md');

    render(<FileTree />);
    fireEvent.click(screen.getByText('Download…'));

    await waitFor(() => expect(tauriCommands.showDownloadDialog).toHaveBeenCalledWith('child.md'));
    await waitFor(() => expect(tauriCommands.writeDownloadedFile).toHaveBeenCalledWith('/home/u/Downloads/child.md', 'QUJD'));
  });

  it('does not write when the download dialog is cancelled', async () => {
    vi.mocked(tauriCommands.readNoteAssetDataUrl).mockResolvedValue('data:text/markdown;base64,QUJD');
    vi.mocked(tauriCommands.showDownloadDialog).mockResolvedValue(null);

    render(<FileTree />);
    fireEvent.click(screen.getByText('Download…'));

    await waitFor(() => expect(tauriCommands.showDownloadDialog).toHaveBeenCalled());
    expect(tauriCommands.writeDownloadedFile).not.toHaveBeenCalled();
  });

  it('reveals a file in the OS file manager for local vaults', async () => {
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        { relativePath: 'note.md', name: 'note.md', extension: 'md', modifiedAt: 1, size: 10, isFolder: false },
      ],
    });
    vi.mocked(tauriCommands.resolveVaultFilePath).mockResolvedValue('/vault/note.md');

    render(<FileTree />);
    fireEvent.click(screen.getByText('Reveal in file manager'));

    await waitFor(() => expect(tauriCommands.resolveVaultFilePath).toHaveBeenCalledWith('/vault', 'note.md'));
    await waitFor(() => expect(tauriCommands.revealInFileManager).toHaveBeenCalledWith('/vault/note.md'));
  });

  it('opens version history from the file context menu for supported files', () => {
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        {
          relativePath: 'Docs/plan.md',
          name: 'plan.md',
          extension: 'md',
          modifiedAt: 1,
          size: 10,
          isFolder: false,
        },
      ],
    });

    render(<FileTree />);

    fireEvent.click(screen.getByText('View version history'));

    expect(screen.getByTestId('version-history-modal').textContent).toBe('Docs/plan.md');
  });

  it('moves a file directly without showing preview when there are no rewrites or open tabs', async () => {
    vi.mocked(tauriCommands.previewRenameMove).mockResolvedValue({
      oldRelativePath: 'Docs/plan.md',
      newRelativePath: 'plan.md',
      itemKind: 'file',
      operation: 'move',
      nestedItemCount: 1,
      affectedReferencePaths: [],
      blockedReason: null,
    });
    vi.mocked(tauriCommands.renameNote).mockResolvedValue();

    useVaultStore.setState({
      ...useVaultStore.getState(),
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
              relativePath: 'Docs/plan.md',
              name: 'plan.md',
              extension: 'md',
              modifiedAt: 1,
              size: 10,
              isFolder: false,
            },
          ],
        },
      ],
    });

    render(<FileTree />);

    const row = screen.getByText('plan.md').closest('[draggable="true"]');
    expect(row).toBeTruthy();
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row!, { dataTransfer });
    fireEvent.dragOver(row!, { dataTransfer });
    fireEvent.drop(row!, { dataTransfer });

    await waitFor(() => {
      expect(tauriCommands.renameNote).toHaveBeenCalledWith('/vault', 'Docs/plan.md', 'plan.md');
    });
  });

  it('keeps the preview flow when moving would rewrite references', async () => {
    vi.mocked(tauriCommands.previewRenameMove).mockResolvedValue({
      oldRelativePath: 'Docs/plan.md',
      newRelativePath: 'plan.md',
      itemKind: 'file',
      operation: 'move',
      nestedItemCount: 1,
      affectedReferencePaths: ['Notes/link.md'],
      blockedReason: null,
    });

    useVaultStore.setState({
      ...useVaultStore.getState(),
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
              relativePath: 'Docs/plan.md',
              name: 'plan.md',
              extension: 'md',
              modifiedAt: 1,
              size: 10,
              isFolder: false,
            },
          ],
        },
      ],
    });

    render(<FileTree />);

    const row = screen.getByText('plan.md').closest('[draggable="true"]');
    expect(row).toBeTruthy();
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row!, { dataTransfer });
    fireEvent.dragOver(row!, { dataTransfer });
    fireEvent.drop(row!, { dataTransfer });

    await waitFor(() => {
      expect(tauriCommands.previewRenameMove).toHaveBeenCalled();
    });
    expect(tauriCommands.renameNote).not.toHaveBeenCalled();
  });

  it('starts a native drag-out on Ctrl-drag movement instead of an in-tree move', async () => {
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        { relativePath: 'plan.md', name: 'plan.md', extension: 'md', modifiedAt: 1, size: 10, isFolder: false },
      ],
    });

    render(<FileTree />);

    const row = screen.getByText('plan.md').closest('[draggable="true"]');
    expect(row).toBeTruthy();
    const dataTransfer = createDataTransfer();

    fireEvent.mouseDown(row!, { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 18, clientY: 10 });

    expect(startFileDragOut).toHaveBeenCalledWith(['/vault/plan.md']);
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it('trashes the hovered file when Delete is pressed', async () => {
    useUiStore.setState({ ...useUiStore.getState(), confirmDelete: false });
    vi.mocked(tauriCommands.moveNoteToTrash).mockResolvedValue(undefined as never);
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        { relativePath: 'a.md', name: 'a.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
        { relativePath: 'b.md', name: 'b.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
      ],
    });

    render(<FileTree />);
    fireEvent.mouseEnter(screen.getByText('a.md'));
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() =>
      expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledWith('/vault', 'a.md', undefined, undefined, false),
    );
    expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledTimes(1);
  });

  it('does not handle Delete when another view already prevented it', () => {
    useUiStore.setState({ ...useUiStore.getState(), confirmDelete: false });
    vi.mocked(tauriCommands.moveNoteToTrash).mockResolvedValue(undefined as never);
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        { relativePath: 'a.md', name: 'a.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
      ],
    });

    render(<FileTree />);
    fireEvent.mouseEnter(screen.getByText('a.md'));
    const event = new KeyboardEvent('keydown', { key: 'Delete', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(tauriCommands.moveNoteToTrash).not.toHaveBeenCalled();
  });

  it('multi-selects files with ctrl-click and trashes all of them on Delete', async () => {
    useUiStore.setState({ ...useUiStore.getState(), confirmDelete: false });
    vi.mocked(tauriCommands.moveNoteToTrash).mockResolvedValue(undefined as never);
    useVaultStore.setState({
      ...useVaultStore.getState(),
      fileTree: [
        { relativePath: 'a.md', name: 'a.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
        { relativePath: 'b.md', name: 'b.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
        { relativePath: 'c.md', name: 'c.md', extension: 'md', modifiedAt: 1, size: 1, isFolder: false },
      ],
    });

    render(<FileTree />);
    fireEvent.click(screen.getByText('a.md'));
    fireEvent.click(screen.getByText('b.md'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledTimes(2));
    expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledWith('/vault', 'a.md', undefined, undefined, false);
    expect(tauriCommands.moveNoteToTrash).toHaveBeenCalledWith('/vault', 'b.md', undefined, undefined, false);
    expect(tauriCommands.moveNoteToTrash).not.toHaveBeenCalledWith('/vault', 'c.md', undefined, undefined, false);
  });

  it('imports files chosen from the add-files dialog', async () => {
    vi.mocked(tauriCommands.showOpenFilesDialog).mockResolvedValue(['/desktop/cat.png']);

    render(<FileTree />);
    fireEvent.click(screen.getByLabelText('Add files to vault'));

    await waitFor(() => expect(tauriCommands.showOpenFilesDialog).toHaveBeenCalledWith(['png', 'pdf', 'md', 'canvas', 'kanban']));
    await waitFor(() => expect(importExternalFilesIntoVault).toHaveBeenCalled());
    expect(importExternalFilesIntoVault.mock.calls[0][1]).toEqual(['/desktop/cat.png']);
  });
});
