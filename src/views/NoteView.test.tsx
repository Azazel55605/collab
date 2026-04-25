import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

const noteEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as null | ((event: { payload?: { path?: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
  renameNote: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload?: { path?: string } }) => void | Promise<void>) => {
    if (eventName === 'vault:file-modified') {
      noteEvents.fileModifiedHandler = handler;
    }
    return () => {
      if (eventName === 'vault:file-modified') {
        noteEvents.fileModifiedHandler = null;
      }
    };
  }),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
    renameNote: tauriMocks.renameNote,
  },
}));

vi.mock('../components/editor/EditorToolbar', () => ({
  EditorToolbar: () => <div data-testid="toolbar" />,
}));

vi.mock('../components/editor/MarkdownEditor', () => ({
  MarkdownEditor: ({ content, onChange }: { content: string; onChange: (content: string) => void }) => (
    <div>
      <div data-testid="editor-content">{content}</div>
      <button type="button" onClick={() => onChange(`${content}\nupdated`)}>
        change
      </button>
    </div>
  ),
}));

vi.mock('../lib/webPreviewCache', () => ({
  extractHttpUrls: vi.fn(() => []),
  prefetchWebPreviews: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import NoteView from './NoteView';

describe('NoteView external reload behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteEvents.fileModifiedHandler = null;

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
      openTabs: [{ relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' }],
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
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
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

  it('reloads on external modification when the note is clean', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: 'initial note', hash: 'hash-1', modifiedAt: 1 })
      .mockResolvedValueOnce({ content: 'external update', hash: 'hash-2', modifiedAt: 2 });

    render(<NoteView relativePath="Notes/a.md" />);

    expect((await screen.findByTestId('editor-content')).textContent).toBe('initial note');

    await noteEvents.fileModifiedHandler?.({ payload: { path: 'Notes/a.md' } });

    await waitFor(() => {
      expect(screen.getByTestId('editor-content').textContent).toBe('external update');
    });

    expect(tauriMocks.readNote).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().openTabs[0]?.savedHash).toBe('hash-2');
  });

  it('does not reload on external modification while the note is dirty', async () => {
    tauriMocks.readNote.mockResolvedValue({ content: 'initial note', hash: 'hash-1', modifiedAt: 1 });

    render(<NoteView relativePath="Notes/a.md" />);

    expect((await screen.findByTestId('editor-content')).textContent).toBe('initial note');

    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await noteEvents.fileModifiedHandler?.({ payload: { path: 'Notes/a.md' } });

    await waitFor(() => {
      expect(screen.getByTestId('editor-content').textContent).toContain('updated');
    });

    expect(tauriMocks.readNote).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().openTabs[0]?.isDirty).toBe(true);
  });
});
