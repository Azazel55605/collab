import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';

import KanbanPage, { useKanbanContext } from './KanbanPage';

const kanbanEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as
    null | ((event: { payload: { path: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
  hostedVaultRequest: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: { path: string } }) => void | Promise<void>,
    ) => {
      if (eventName === 'vault:file-modified') {
        kanbanEvents.fileModifiedHandler = handler;
      }
      return () => {
        if (eventName === 'vault:file-modified') {
          kanbanEvents.fileModifiedHandler = null;
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
    hostedVaultRequest: tauriMocks.hostedVaultRequest,
  },
}));

vi.mock('../components/collaboration/CollabProvider', () => ({
  useCollabContext: () => ({
    readVaultConfig: vi.fn(async () => ({
      id: 'config-1',
      name: 'Vault',
      knownUsers: [],
      owner: 'user-1',
      members: [],
    })),
  }),
}));

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

vi.mock('../components/kanban/KanbanBoard', () => ({
  default: function MockKanbanBoard() {
    const { board, updateBoard, sessionStatus } = useKanbanContext();
    return (
      <div>
        <div data-testid="card-count">{board.columns[0]?.cards.length ?? 0}</div>
        <div data-testid="session-status">{sessionStatus}</div>
        <button
          type="button"
          onClick={() =>
            updateBoard((prev) => ({
              ...prev,
              columns: prev.columns.map((column, index) =>
                index === 0
                  ? {
                      ...column,
                      cards: [
                        ...column.cards,
                        {
                          id: 'card-1',
                          title: 'Test card',
                          assignees: [],
                          tags: [],
                          comments: [],
                          checklist: [],
                        },
                      ],
                    }
                  : column,
              ),
            }))
          }
        >
          add card
        </button>
      </div>
    );
  },
}));

describe('KanbanPage save behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kanbanEvents.fileModifiedHandler = null;

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
        {
          relativePath: 'Boards/test.kanban',
          title: 'test',
          isDirty: false,
          savedHash: null,
          type: 'kanban',
        },
      ],
      activeTabPath: 'Boards/test.kanban',
      forceReloadPath: null,
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });

    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        columns: [{ id: 'col-1', title: 'To Do', cards: [] }],
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('surfaces optimistic-write conflicts through the document status', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-conflict',
      conflict: {
        relativePath: 'Boards/test.kanban',
        ourContent: 'ours',
        theirContent: JSON.stringify({ columns: [{ id: 'col-1', title: 'To Do', cards: [] }] }),
      },
    });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    await screen.findByTestId('card-count');
    fireEvent.click(screen.getByRole('button', { name: 'add card' }));

    // The controller latches the conflict and pauses autosave; the shared status
    // surfaces it for review instead of the legacy modal dialog.
    await waitFor(
      () => {
        expect(screen.getByTestId('session-status').textContent).toBe('conflict');
      },
      { timeout: 2000 },
    );
    expect(tauriMocks.createSnapshot).not.toHaveBeenCalled();
  });

  it('creates a snapshot after a successful save', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-2',
    });
    tauriMocks.createSnapshot.mockResolvedValue({
      id: 'snap-1',
      relativePath: 'Boards/test.kanban',
      authorId: 'user-1',
      authorName: 'Test User',
      timestamp: 1,
      hash: 'hash-2',
    });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    await screen.findByTestId('card-count');
    fireEvent.click(screen.getByRole('button', { name: 'add card' }));
    await wait(700);

    await waitFor(() => {
      expect(tauriMocks.writeNote).toHaveBeenCalledTimes(1);
      expect(tauriMocks.createSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(tauriMocks.createSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Boards/test.kanban',
      expect.stringContaining('"Test card"'),
      'user-1',
      'Test User',
      undefined,
    );
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.kanban',
        isDirty: false,
        savedHash: 'hash-2',
      }),
    );
  });

  it('reloads when a watcher event arrives and there are no local edits', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({
        content: JSON.stringify({
          columns: [{ id: 'col-1', title: 'To Do', cards: [] }],
        }),
        hash: 'hash-1',
        modifiedAt: 1,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          columns: [
            {
              id: 'col-1',
              title: 'To Do',
              cards: [
                {
                  id: 'card-2',
                  title: 'Remote card',
                  assignees: [],
                  tags: [],
                  comments: [],
                  checklist: [],
                },
              ],
            },
          ],
        }),
        hash: 'hash-2',
        modifiedAt: 2,
      });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    expect((await screen.findByTestId('card-count')).textContent).toBe('0');

    await kanbanEvents.fileModifiedHandler?.({ payload: { path: 'Boards/test.kanban' } });

    await waitFor(() => {
      expect(screen.getByTestId('card-count').textContent).toBe('1');
    });

    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.kanban',
        savedHash: 'hash-2',
      }),
    );
  });

  it('drops board mutations and never writes for a hosted viewer', async () => {
    const hostedFile = {
      id: 'file-1',
      parentId: null,
      name: 'test.kanban',
      relativePath: 'Boards/test.kanban',
      kind: 'document',
      documentType: 'kanban',
      state: 'active',
      currentRevision: {
        id: 'revision-1',
        sequence: 1,
        contentHash: 'hash-1',
        sizeBytes: 10,
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
      .mockResolvedValueOnce({
        file: hostedFile,
        content: JSON.stringify({ columns: [{ id: 'col-1', title: 'To Do', cards: [] }] }),
      });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    expect((await screen.findByTestId('card-count')).textContent).toBe('0');

    const callsAfterLoad = tauriMocks.hostedVaultRequest.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'add card' }));
    await wait(700);

    // The mutation is dropped (no card added) and no write request is issued.
    expect(screen.getByTestId('card-count').textContent).toBe('0');
    expect(tauriMocks.hostedVaultRequest.mock.calls.length).toBe(callsAfterLoad);
  });

  it('does not reload when a watcher event arrives during local unsaved edits', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        columns: [{ id: 'col-1', title: 'To Do', cards: [] }],
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    expect((await screen.findByTestId('card-count')).textContent).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'add card' }));

    await kanbanEvents.fileModifiedHandler?.({ payload: { path: 'Boards/test.kanban' } });
    await wait(50);

    expect(screen.getByTestId('card-count').textContent).toBe('1');
    // The controller re-reads to evaluate the candidate, but with an unchanged
    // version it is stale and must not replace the dirty local board.
    expect(tauriMocks.readNote).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.kanban',
        isDirty: true,
      }),
    );
  });
});
