import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';

const kanbanEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as null | ((event: { payload: { path: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: { path: string } }) => void | Promise<void>) => {
    if (eventName === 'vault:file-modified') {
      kanbanEvents.fileModifiedHandler = handler;
    }
    return () => {
      if (eventName === 'vault:file-modified') {
        kanbanEvents.fileModifiedHandler = null;
      }
    };
  }),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
  },
}));

vi.mock('../components/collaboration/CollabProvider', () => ({
  useCollabContext: () => ({
    readVaultConfig: vi.fn(async () => ({ id: 'config-1', name: 'Vault', knownUsers: [], owner: 'user-1', members: [] })),
  }),
}));

import KanbanPage, { useKanbanContext } from './KanbanPage';

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

vi.mock('../components/kanban/KanbanBoard', () => ({
  default: function MockKanbanBoard() {
    const { board, updateBoard } = useKanbanContext();
    return (
      <div>
        <div data-testid="card-count">{board.columns[0]?.cards.length ?? 0}</div>
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
      openTabs: [{ relativePath: 'Boards/test.kanban', title: 'test', isDirty: false, savedHash: null, type: 'kanban' }],
      activeTabPath: 'Boards/test.kanban',
      forceReloadPath: null,
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

  it('surfaces optimistic-write conflicts through collabStore', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-conflict',
      conflict: {
        relativePath: 'Boards/test.kanban',
        ourContent: 'ours',
        theirContent: 'theirs',
      },
    });

    render(<KanbanPage relativePath="Boards/test.kanban" />);

    await screen.findByTestId('card-count');
    fireEvent.click(screen.getByRole('button', { name: 'add card' }));
    await wait(700);

    await waitFor(() => {
      expect(useCollabStore.getState().conflicts).toHaveLength(1);
    });

    expect(useCollabStore.getState().conflicts[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.kanban',
        theirContent: 'theirs',
      }),
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
          columns: [{ id: 'col-1', title: 'To Do', cards: [{ id: 'card-2', title: 'Remote card', assignees: [], tags: [], comments: [], checklist: [] }] }],
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
    expect(tauriMocks.readNote).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.kanban',
        isDirty: true,
      }),
    );
  });
});
