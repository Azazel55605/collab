import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useCollabStore } from '../store/collabStore';
import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

import NoteView from './NoteView';

const noteEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as
    null | ((event: { payload?: { path?: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
  renameNote: vi.fn(),
  listNoteSnippets: vi.fn(async () => []),
  hostedVaultRequest: vi.fn(),
  replicaCacheDocument: vi.fn(async () => undefined),
}));

const liveMocks = vi.hoisted(() => ({
  openLiveNoteSession: vi.fn(async () => null as unknown),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload?: { path?: string } }) => void | Promise<void>,
    ) => {
      if (eventName === 'vault:file-modified') {
        noteEvents.fileModifiedHandler = handler;
      }
      return () => {
        if (eventName === 'vault:file-modified') {
          noteEvents.fileModifiedHandler = null;
        }
      };
    },
  ),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
    renameNote: tauriMocks.renameNote,
    listNoteSnippets: tauriMocks.listNoteSnippets,
    hostedVaultRequest: tauriMocks.hostedVaultRequest,
    replicaCacheDocument: tauriMocks.replicaCacheDocument,
  },
}));

// Live collaboration is disabled by default in these tests; the dedicated live
// test overrides this to return a session.
vi.mock('../lib/liveDocumentSession', () => ({
  openLiveNoteSession: liveMocks.openLiveNoteSession,
}));

vi.mock('y-codemirror.next', () => ({
  yCollab: vi.fn(() => []),
}));

vi.mock('../components/editor/EditorToolbar', () => ({
  EditorToolbar: () => <div data-testid="toolbar" />,
}));

vi.mock('../components/editor/MarkdownEditor', () => ({
  MarkdownEditor: ({
    content,
    onChange,
    readOnly,
  }: {
    content: string;
    onChange: (content: string) => void;
    readOnly?: boolean;
  }) => (
    <div>
      <div data-testid="editor-content">{content}</div>
      <div data-testid="editor-readonly">{String(!!readOnly)}</div>
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

describe('NoteView external reload behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteEvents.fileModifiedHandler = null;

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
      openTabs: [
        { relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' },
      ],
      activeTabPath: 'Notes/a.md',
      forceReloadPath: null,
      revealEditorPath: null,
      noteViewStates: {},
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
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });
  });

  afterEach(() => {
    cleanup();
    useDocumentStatusStore.setState({ statuses: {} });
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
    tauriMocks.readNote.mockResolvedValue({
      content: 'initial note',
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<NoteView relativePath="Notes/a.md" />);

    expect((await screen.findByTestId('editor-content')).textContent).toBe('initial note');

    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await noteEvents.fileModifiedHandler?.({ payload: { path: 'Notes/a.md' } });

    await waitFor(() => {
      expect(screen.getByTestId('editor-content').textContent).toContain('updated');
    });

    // The controller re-reads to evaluate the candidate, but with an unchanged
    // version it is stale and must not replace the dirty local content.
    expect(tauriMocks.readNote).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('editor-content').textContent).not.toBe('initial note');
    expect(useEditorStore.getState().openTabs[0]?.isDirty).toBe(true);
  });

  it('queues a newer remote change while dirty and applies it on Load latest', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: 'initial note', hash: 'hash-1', modifiedAt: 1 })
      .mockResolvedValue({ content: 'external update', hash: 'hash-2', modifiedAt: 2 });
    tauriMocks.writeNote.mockResolvedValue({ hash: 'hash-saved' });

    render(<NoteView relativePath="Notes/a.md" />);
    expect((await screen.findByTestId('editor-content')).textContent).toBe('initial note');

    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await waitFor(() =>
      expect(screen.getByTestId('editor-content').textContent).toContain('updated'),
    );

    await noteEvents.fileModifiedHandler?.({ payload: { path: 'Notes/a.md' } });

    // A newer remote (hash-2) is queued as pending, not applied over local edits.
    await waitFor(() => {
      expect(useDocumentStatusStore.getState().statuses['Notes/a.md']?.status).toBe(
        'remote-pending',
      );
    });
    expect(screen.getByTestId('editor-content').textContent).not.toBe('external update');

    // Load latest applies the queued remote content (via the registered
    // session controller that drives the central reconciliation surface).
    act(() => {
      useDocumentStatusStore.getState().statuses['Notes/a.md']?.controller?.loadRemote();
    });
    await waitFor(() =>
      expect(screen.getByTestId('editor-content').textContent).toBe('external update'),
    );
  });

  it('auto-merges a non-overlapping remote change while dirty (three-way merge)', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({ content: 'line1\nline2\n', hash: 'hash-1', modifiedAt: 1 })
      // Remote changed the first line; the local edit appends a trailing line,
      // so the two edits are disjoint and merge cleanly.
      .mockResolvedValue({ content: 'line1 remote\nline2\n', hash: 'hash-2', modifiedAt: 2 });
    tauriMocks.writeNote.mockResolvedValue({ hash: 'hash-saved' });

    render(<NoteView relativePath="Notes/a.md" />);
    await screen.findByTestId('editor-content');

    // Local edit appends "\nupdated" to the end.
    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await waitFor(() =>
      expect(screen.getByTestId('editor-content').textContent).toContain('updated'),
    );

    await noteEvents.fileModifiedHandler?.({ payload: { path: 'Notes/a.md' } });

    // Both edits survive; no pending review is needed.
    await waitFor(() => {
      const text = screen.getByTestId('editor-content').textContent ?? '';
      expect(text).toContain('line1 remote');
      expect(text).toContain('updated');
    });
    expect(useDocumentStatusStore.getState().statuses['Notes/a.md']?.status).not.toBe(
      'remote-pending',
    );
  });

  it('serializes overlapping autosaves on a slow connection (no stale-revision write)', async () => {
    tauriMocks.readNote.mockResolvedValue({ content: 'initial', hash: 'hash-1', modifiedAt: 1 });
    // A slow write: each call resolves only when we release it, modelling latency.
    const deferred: Array<(value: { hash: string }) => void> = [];
    tauriMocks.writeNote.mockImplementation(
      () =>
        new Promise<{ hash: string }>((resolve) => {
          deferred.push(resolve);
        }),
    );

    render(<NoteView relativePath="Notes/a.md" />);
    await screen.findByTestId('editor-content');

    // First edit → first autosave fires and the (slow) write goes in flight.
    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await waitFor(() => expect(tauriMocks.writeNote).toHaveBeenCalledTimes(1));
    expect(tauriMocks.writeNote.mock.calls[0][3]).toBe('hash-1');

    // A second edit lands while the first write is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    // It must NOT start a second concurrent write with the same stale revision.
    expect(tauriMocks.writeNote).toHaveBeenCalledTimes(1);

    // Finishing the first write releases the coalesced trailing write, which now
    // uses the version returned by the first one.
    deferred[0]({ hash: 'hash-2' });
    await waitFor(() => expect(tauriMocks.writeNote).toHaveBeenCalledTimes(2));
    expect(tauriMocks.writeNote.mock.calls[1][3]).toBe('hash-2');
    deferred[1]?.({ hash: 'hash-3' });
  });

  it('opens hosted markdown notes when app-only snippet loading hits the legacy vault-path error', async () => {
    const hostedFile = {
      id: 'file-1',
      parentId: null,
      name: 'a.md',
      relativePath: 'Notes/a.md',
      kind: 'document',
      documentType: 'note',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 11,
        createdByDisplayName: 'Test User',
        createdAt: '2026-06-11T08:00:00Z',
      },
      createdAt: '2026-06-11T08:00:00Z',
      updatedAt: '2026-06-11T08:00:00Z',
    };
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: Date.now(),
        isEncrypted: false,
      },
    });
    tauriMocks.hostedVaultRequest
      .mockResolvedValueOnce({ vaultId: 'hosted-vault', sequence: 1, files: [hostedFile] })
      .mockResolvedValueOnce({ file: hostedFile, content: 'hosted note' });
    tauriMocks.listNoteSnippets.mockRejectedValueOnce(
      new Error('Vault path is required for vault note snippets'),
    );

    render(<NoteView relativePath="Notes/a.md" />);

    expect((await screen.findByTestId('editor-content')).textContent).toBe('hosted note');
    expect(tauriMocks.listNoteSnippets).toHaveBeenCalledWith(null);
  });

  it('renders read-only and never writes when the hosted vault grants only viewer access', async () => {
    const hostedFile = {
      id: 'file-1',
      parentId: null,
      name: 'a.md',
      relativePath: 'Notes/a.md',
      kind: 'document',
      documentType: 'note',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 11,
        createdByDisplayName: 'Test User',
        createdAt: '2026-06-11T08:00:00Z',
      },
      createdAt: '2026-06-11T08:00:00Z',
      updatedAt: '2026-06-11T08:00:00Z',
    };
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'viewer',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: Date.now(),
        isEncrypted: false,
      },
    });
    tauriMocks.hostedVaultRequest
      .mockResolvedValueOnce({ vaultId: 'hosted-vault', sequence: 1, files: [hostedFile] })
      .mockResolvedValueOnce({ file: hostedFile, content: 'hosted note' });

    render(<NoteView relativePath="Notes/a.md" />);

    expect((await screen.findByTestId('editor-content')).textContent).toBe('hosted note');
    // The read-only banner replaces the editing toolbar and the editor is non-editable.
    expect(screen.queryByTestId('toolbar')).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    expect(screen.getByTestId('editor-readonly').textContent).toBe('true');

    const callsAfterLoad = tauriMocks.hostedVaultRequest.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    // Wait past the autosave debounce window; no write request must be issued.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(tauriMocks.hostedVaultRequest.mock.calls.length).toBe(callsAfterLoad);
  });

  it('drives a hosted note from the live session and never writes through REST', async () => {
    const hostedFile = {
      id: 'file-1',
      parentId: null,
      name: 'a.md',
      relativePath: 'Notes/a.md',
      kind: 'document',
      documentType: 'note',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 11,
        createdByDisplayName: 'Test User',
        createdAt: '2026-06-11T08:00:00Z',
      },
      createdAt: '2026-06-11T08:00:00Z',
      updatedAt: '2026-06-11T08:00:00Z',
    };
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        name: 'Hosted Vault',
        path: 'hosted://hosted-vault',
        lastOpened: Date.now(),
        isEncrypted: false,
      },
    });
    tauriMocks.hostedVaultRequest
      .mockResolvedValueOnce({ vaultId: 'hosted-vault', sequence: 1, files: [hostedFile] })
      .mockResolvedValueOnce({ file: hostedFile, content: 'rest body' });

    // The live session exposes a Yjs document seeded with the live content.
    const ydoc = new Y.Doc();
    const text = ydoc.getText('content');
    text.insert(0, 'live body');
    const session = {
      doc: ydoc,
      text,
      awareness: new Awareness(ydoc),
      getStatus: () => 'connected' as const,
      onStatus: () => () => {},
      destroy: vi.fn(),
    };
    liveMocks.openLiveNoteSession.mockResolvedValueOnce(session);

    render(<NoteView relativePath="Notes/a.md" />);

    // The editor shows the live document content, not the REST content.
    await waitFor(() => {
      expect(screen.getByTestId('editor-content').textContent).toBe('live body');
    });

    const callsAfterLoad = tauriMocks.hostedVaultRequest.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    // Past the autosave debounce: live edits persist via the server, never REST.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(tauriMocks.hostedVaultRequest.mock.calls.length).toBe(callsAfterLoad);
  });
});
