import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { HostedFileEntry } from '../mobileTauri';
import {
  addColumn,
  createColumn,
  addCardToColumn,
  addChecklistItem,
  addComment,
  addTag,
  collectBoardTags,
  createCard,
  findCard,
  isKanbanFile,
  moveColumn,
  moveCardToColumn,
  parseBoardContent,
  readKanbanDocument,
  removeCard,
  removeColumn,
  removeTag,
  saveKanbanDocument,
  serializeBoard,
  toggleCardDone,
  toggleChecklistItem,
  updateColumn,
  viewCards,
  type KanbanBoard,
  type KanbanCard,
} from './kanban';

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const BOARD_FILE: HostedFileEntry = {
  id: 'board-1',
  parentId: null,
  name: 'Sprint.kanban',
  relativePath: 'Sprint.kanban',
  kind: 'document',
  documentType: 'kanban',
  state: 'active',
  updatedAt: null,
  sizeBytes: 10,
  contentHash: 'hash',
  revisionSequence: 4,
};

function boardWithCard(): { board: KanbanBoard; cardId: string; todoId: string; doneId: string } {
  const card = createCard('Write tests');
  const todoId = 'col-todo';
  const doneId = 'col-done';
  const board: KanbanBoard = {
    columns: [
      { id: todoId, title: 'To Do', cards: [card] },
      { id: doneId, title: 'Done', cards: [] },
    ],
  };
  return { board, cardId: card.id, todoId, doneId };
}

describe('mobile kanban model', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('recognizes kanban documents', () => {
    expect(isKanbanFile(BOARD_FILE)).toBe(true);
    expect(isKanbanFile({ ...BOARD_FILE, documentType: null, name: 'Board.kanban' })).toBe(true);
    expect(isKanbanFile({ ...BOARD_FILE, documentType: 'note', name: 'Note.md' })).toBe(false);
    expect(isKanbanFile({ ...BOARD_FILE, kind: 'asset', name: 'x.kanban' })).toBe(false);
  });

  it('round-trips board content through parse/serialize with normalization', () => {
    const { board } = boardWithCard();
    const parsed = parseBoardContent(serializeBoard(board));
    expect(parsed.columns).toHaveLength(2);
    // normalizeKanbanBoard fills optional fields.
    expect(parsed.savedFilters).toEqual([]);
    expect(parsed.automations).toEqual([]);
    // Empty/invalid content degrades to an empty board rather than throwing.
    expect(parseBoardContent('').columns).toEqual([]);
    expect(parseBoardContent('{not json').columns).toEqual([]);
  });

  it('adds, moves, and removes cards', () => {
    const { board, cardId, todoId, doneId } = boardWithCard();

    const withNew = addCardToColumn(board, todoId, createCard('Second'));
    expect(withNew.columns[0].cards).toHaveLength(2);

    const moved = moveCardToColumn(board, cardId, doneId);
    expect(findCard(moved, cardId)?.columnId).toBe(doneId);
    expect(moved.columns[0].cards).toHaveLength(0);

    // Moving to the same column is a no-op (returns the same reference).
    expect(moveCardToColumn(board, cardId, todoId)).toBe(board);

    const removed = removeCard(board, cardId);
    expect(findCard(removed, cardId)).toBeNull();
  });

  it('edits tags, checklist, done state, and comments', () => {
    const { board, cardId } = boardWithCard();

    const tagged = addTag(board, cardId, 'urgent');
    expect(findCard(tagged, cardId)?.card.tags).toEqual(['urgent']);
    // Duplicate tags are ignored.
    expect(addTag(tagged, cardId, 'urgent').columns[0].cards[0].tags).toEqual(['urgent']);
    expect(findCard(removeTag(tagged, cardId, 'urgent'), cardId)?.card.tags).toEqual([]);

    const checklisted = addChecklistItem(board, cardId, 'Step one');
    const item = findCard(checklisted, cardId)!.card.checklist[0];
    expect(item.text).toBe('Step one');
    expect(item.checked).toBe(false);
    const checked = toggleChecklistItem(checklisted, cardId, item.id, true);
    expect(findCard(checked, cardId)!.card.checklist[0].checked).toBe(true);

    const done = toggleCardDone(board, cardId, true);
    expect(findCard(done, cardId)?.card.isDone).toBe(true);

    const commented = addComment(board, cardId, 'Looks good', {
      userId: 'u1',
      userName: 'Ada',
      userColor: '#fff',
    });
    const comment = findCard(commented, cardId)!.card.comments[0];
    expect(comment).toMatchObject({ userId: 'u1', userName: 'Ada', content: 'Looks good' });
    // Blank comments are ignored.
    expect(addComment(board, cardId, '   ', { userId: 'u1', userName: 'Ada', userColor: '#fff' })).toBe(board);
  });

  it('collects board tags and filters/sorts a column view without mutating', () => {
    const cards: KanbanCard[] = [
      { ...createCard('Beta'), priority: 'low', dueDate: '2026-08-01', createdAt: 100, tags: ['api'] },
      { ...createCard('Alpha'), priority: 'high', dueDate: '2026-07-15', createdAt: 300, tags: ['ui', 'api'] },
      { ...createCard('Gamma'), createdAt: 200, tags: ['ui'] },
    ];
    const board: KanbanBoard = { columns: [{ id: 'c', title: 'Col', cards }] };

    expect(collectBoardTags(board)).toEqual(['api', 'ui']);

    // Manual sort preserves stored order and never mutates the input.
    const manual = viewCards(cards, '', 'manual');
    expect(manual.map((card) => card.title)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(cards.map((card) => card.title)).toEqual(['Beta', 'Alpha', 'Gamma']);

    expect(viewCards(cards, '', 'title').map((card) => card.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // High priority first; unset priority sorts last.
    expect(viewCards(cards, '', 'priority').map((card) => card.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // Earliest due date first; cards without a due date sort last.
    expect(viewCards(cards, '', 'due').map((card) => card.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // Newest created first.
    expect(viewCards(cards, '', 'created').map((card) => card.title)).toEqual(['Alpha', 'Gamma', 'Beta']);

    // Text filter matches title/description/tags.
    expect(viewCards(cards, 'ui', 'manual').map((card) => card.title)).toEqual(['Alpha', 'Gamma']);
    expect(viewCards(cards, 'zzz', 'manual')).toHaveLength(0);
  });

  it('reads a board online and warms the replica cache', async () => {
    const { board } = boardWithCard();
    const content = serializeBoard(board);
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({ file: { ...BOARD_FILE, currentRevision: { sequence: 4 } }, content });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readKanbanDocument(SERVER, VAULT, BOARD_FILE, true);
    expect(loaded.source).toBe('network');
    expect(loaded.board.columns).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('replica_cache_document', expect.objectContaining({ fileId: 'board-1' }));
  });

  it('falls back to the cached board when offline', async () => {
    const { board } = boardWithCard();
    const content = serializeBoard(board);
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_cached_document') return Promise.resolve(content);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const loaded = await readKanbanDocument(SERVER, VAULT, BOARD_FILE, false);
    expect(loaded.source).toBe('cache');
    expect(loaded.board.columns).toHaveLength(2);
  });

  it('saves a board as a hosted revision against the current sequence', async () => {
    const { board } = boardWithCard();
    let posted: Record<string, unknown> | null = null;
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'hosted_vault_request') {
        posted = args;
        return Promise.resolve({ file: { ...BOARD_FILE, currentRevision: { sequence: 5 } }, content: serializeBoard(board) });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const result = await saveKanbanDocument(SERVER, VAULT, BOARD_FILE, board);
    expect(posted!.path).toBe(`/api/v1/vaults/${VAULT}/files/board-1/revisions`);
    expect((posted!.body as Record<string, unknown>).expectedRevisionSequence).toBe(4);
    expect(result.file.revisionSequence).toBe(5);
  });

  it('creates, edits, reorders, and removes empty columns', () => {
    const first = createColumn('Backlog');
    const second = createColumn('Doing');
    let board = addColumn(addColumn({ columns: [] }, first), second);
    board = updateColumn(board, first.id, (column) => ({ ...column, title: 'Ready' }));
    board = moveColumn(board, second.id, -1);
    expect(board.columns.map((column) => column.title)).toEqual(['Doing', 'Ready']);
    expect(removeColumn(board, first.id).columns).toHaveLength(1);
  });

  it('refuses to remove a non-empty column', () => {
    const { board, todoId } = boardWithCard();
    expect(() => removeColumn(board, todoId)).toThrow(/every card/);
  });
});
