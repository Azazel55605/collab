/**
 * Mobile Kanban document model (Phase 5, Kanban MVP).
 *
 * A `.kanban` file is a JSON text document holding a {@link KanbanBoard}. It is
 * read/written through the same hosted text-document + offline-replica path the
 * notes MVP uses, so board edits queue and replay through the shared native
 * pending-operation store. Board schema and normalization are reused from the
 * desktop `src/types/kanban.ts` so the two clients never fork the document
 * model; only a small set of touch-friendly mutation helpers live here.
 */

import {
  normalizeKanbanBoard,
  setCardDoneState,
  type ChecklistItem,
  type KanbanBoard,
  type KanbanCard,
  type KanbanComment,
  type KanbanColumn,
  type KanbanPriority,
} from '../../../../src/types/kanban';
import {
  HostedFileEntry,
  HostedTextDocument,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
  writeHostedDocument,
} from '../mobileTauri';

export type {
  ChecklistItem,
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanComment,
  KanbanPriority,
};

export function isKanbanFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'kanban') return true;
  return /\.kanban$/i.test(file.name);
}

/** Parse and normalize `.kanban` document content; empty/invalid → empty board. */
export function parseBoardContent(content: string): KanbanBoard {
  if (!content.trim()) return normalizeKanbanBoard({ columns: [] });
  try {
    return normalizeKanbanBoard(JSON.parse(content) as KanbanBoard);
  } catch {
    return normalizeKanbanBoard({ columns: [] });
  }
}

/** Canonical serialization written back to the vault (matches the desktop form). */
export function serializeBoard(board: KanbanBoard): string {
  return JSON.stringify(normalizeKanbanBoard(board), null, 2);
}

export interface LoadedBoard {
  file: HostedFileEntry;
  board: KanbanBoard;
  content: string;
  source: 'network' | 'cache';
}

/**
 * Read a board online (warming the replica cache) and fall back to the offline
 * replica when the server is unreachable. Mirrors `readNoteDocument`.
 */
export async function readKanbanDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedBoard> {
  if (connected) {
    try {
      const document = await readHostedDocument(serverUrl, vaultId, file.id);
      void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
      return {
        file: document.file,
        board: parseBoardContent(document.content),
        content: document.content,
        source: 'network',
      };
    } catch (error) {
      const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
      if (cached !== null) {
        return { file, board: parseBoardContent(cached), content: cached, source: 'cache' };
      }
      throw error;
    }
  }

  const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id);
  if (cached === null) {
    throw new Error('This board is not cached for offline reading.');
  }
  return { file, board: parseBoardContent(cached), content: cached, source: 'cache' };
}

/**
 * Persist a board online, posting a new revision against the file's current
 * revision sequence and warming the replica cache. Returns the updated file.
 */
export async function saveKanbanDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  board: KanbanBoard,
): Promise<HostedTextDocument> {
  const content = serializeBoard(board);
  const expectedRevisionSequence = file.revisionSequence ?? 0;
  const document = await writeHostedDocument(serverUrl, vaultId, file.id, expectedRevisionSequence, content);
  void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
  return document;
}

// ── Touch-friendly board mutations ───────────────────────────────────────────

/** Locate a card and its owning column id anywhere on the board. */
export function findCard(
  board: KanbanBoard,
  cardId: string,
): { card: KanbanCard; columnId: string } | null {
  for (const column of board.columns) {
    const card = column.cards.find((entry) => entry.id === cardId);
    if (card) return { card, columnId: column.id };
  }
  return null;
}

export function createCard(title: string): KanbanCard {
  return {
    id: crypto.randomUUID(),
    title: title.trim() || 'Untitled card',
    assignees: [],
    tags: [],
    comments: [],
    checklist: [],
    createdAt: Date.now(),
  };
}

export function createColumn(title: string): KanbanColumn {
  return {
    id: crypto.randomUUID(),
    title: title.trim() || 'Untitled column',
    cards: [],
  };
}

export function addColumn(board: KanbanBoard, column: KanbanColumn): KanbanBoard {
  return { ...board, columns: [...board.columns, column] };
}

export function updateColumn(
  board: KanbanBoard,
  columnId: string,
  patch: (column: KanbanColumn) => KanbanColumn,
): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => column.id === columnId ? patch(column) : column),
  };
}

export function moveColumn(board: KanbanBoard, columnId: string, offset: -1 | 1): KanbanBoard {
  const index = board.columns.findIndex((column) => column.id === columnId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= board.columns.length) return board;
  const columns = [...board.columns];
  [columns[index], columns[target]] = [columns[target], columns[index]];
  return { ...board, columns };
}

export function removeColumn(board: KanbanBoard, columnId: string): KanbanBoard {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  if (!column) return board;
  if (column.cards.length > 0) {
    throw new Error('Move or delete every card before deleting this column.');
  }
  return { ...board, columns: board.columns.filter((candidate) => candidate.id !== columnId) };
}

export function setCardArchived(
  board: KanbanBoard,
  cardId: string,
  archived: boolean,
  actor?: Pick<CommentAuthor, 'userId' | 'userName'>,
): KanbanBoard {
  const located = findCard(board, cardId);
  if (!located) return board;
  return updateCard(board, cardId, (card) => ({
    ...card,
    archived: archived ? true : undefined,
    archivedColumnId: archived ? located.columnId : undefined,
    archivedAt: archived ? Date.now() : undefined,
    archivedByUserId: archived ? actor?.userId : undefined,
    archivedByUserName: archived ? actor?.userName : undefined,
  }));
}

/** Append a new card to a column. */
export function addCardToColumn(board: KanbanBoard, columnId: string, card: KanbanCard): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) =>
      column.id === columnId ? { ...column, cards: [...column.cards, card] } : column,
    ),
  };
}

/** Replace a single card in place, wherever it lives. */
export function updateCard(
  board: KanbanBoard,
  cardId: string,
  patch: (card: KanbanCard) => KanbanCard,
): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => {
      if (!column.cards.some((card) => card.id === cardId)) return column;
      return {
        ...column,
        cards: column.cards.map((card) => (card.id === cardId ? patch(card) : card)),
      };
    }),
  };
}

/** Remove a card from the board. */
export function removeCard(board: KanbanBoard, cardId: string): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.filter((card) => card.id !== cardId),
    })),
  };
}

/** Move a card to the end of another column (no-op if already there). */
export function moveCardToColumn(board: KanbanBoard, cardId: string, targetColumnId: string): KanbanBoard {
  const located = findCard(board, cardId);
  if (!located || located.columnId === targetColumnId) return board;
  const { card } = located;
  return {
    ...board,
    columns: board.columns.map((column) => {
      if (column.id === located.columnId) {
        return { ...column, cards: column.cards.filter((entry) => entry.id !== cardId) };
      }
      if (column.id === targetColumnId) {
        return {
          ...column,
          cards: [...column.cards, column.autoComplete ? { ...card, isDone: true } : card],
        };
      }
      return column;
    }),
  };
}

/** Toggle a card's done state, spawning the next occurrence for recurring cards. */
export function toggleCardDone(board: KanbanBoard, cardId: string, isDone: boolean): KanbanBoard {
  return setCardDoneState(board, cardId, isDone);
}

export function toggleChecklistItem(
  board: KanbanBoard,
  cardId: string,
  itemId: string,
  checked: boolean,
): KanbanBoard {
  return updateCard(board, cardId, (card) => ({
    ...card,
    checklist: card.checklist.map((item) => (item.id === itemId ? { ...item, checked } : item)),
  }));
}

export function addChecklistItem(board: KanbanBoard, cardId: string, text: string): KanbanBoard {
  const trimmed = text.trim();
  if (!trimmed) return board;
  const item: ChecklistItem = { id: crypto.randomUUID(), text: trimmed, checked: false };
  return updateCard(board, cardId, (card) => ({ ...card, checklist: [...card.checklist, item] }));
}

export function removeChecklistItem(board: KanbanBoard, cardId: string, itemId: string): KanbanBoard {
  return updateCard(board, cardId, (card) => ({
    ...card,
    checklist: card.checklist.filter((item) => item.id !== itemId),
  }));
}

export function addTag(board: KanbanBoard, cardId: string, tag: string): KanbanBoard {
  const trimmed = tag.trim();
  if (!trimmed) return board;
  return updateCard(board, cardId, (card) =>
    card.tags.includes(trimmed) ? card : { ...card, tags: [...card.tags, trimmed] },
  );
}

export function removeTag(board: KanbanBoard, cardId: string, tag: string): KanbanBoard {
  return updateCard(board, cardId, (card) => ({
    ...card,
    tags: card.tags.filter((entry) => entry !== tag),
  }));
}

export interface CommentAuthor {
  userId: string;
  userName: string;
  userColor: string;
}

export function addComment(
  board: KanbanBoard,
  cardId: string,
  content: string,
  author: CommentAuthor,
): KanbanBoard {
  const trimmed = content.trim();
  if (!trimmed) return board;
  const comment: KanbanComment = {
    id: crypto.randomUUID(),
    userId: author.userId,
    userName: author.userName,
    userColor: author.userColor,
    content: trimmed,
    timestamp: Date.now(),
  };
  return updateCard(board, cardId, (card) => ({ ...card, comments: [...card.comments, comment] }));
}

/** Checklist completion counts for a card, for compact progress display. */
export function checklistProgress(card: KanbanCard): { done: number; total: number } {
  return {
    done: card.checklist.filter((item) => item.checked).length,
    total: card.checklist.length,
  };
}

// ── View-local filtering + sorting ───────────────────────────────────────────

export type CardSortField = 'manual' | 'title' | 'priority' | 'due' | 'created';

const PRIORITY_RANK: Record<KanbanPriority | 'none', number> = { high: 3, medium: 2, low: 1, none: 0 };

/** Distinct tags used across every card on the board, sorted alphabetically. */
export function collectBoardTags(board: KanbanBoard): string[] {
  const set = new Set<string>();
  for (const column of board.columns) {
    for (const card of column.cards) for (const tag of card.tags) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Apply a view-local text filter and sort to a column's cards. This never
 * mutates the board — it only affects presentation, so `manual` preserves the
 * stored card order.
 */
export function viewCards(cards: KanbanCard[], query: string, sort: CardSortField): KanbanCard[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? cards.filter((card) =>
        [card.title, card.description ?? '', ...card.tags].join(' ').toLowerCase().includes(q),
      )
    : cards;
  if (sort === 'manual') return filtered;
  const sorted = [...filtered];
  sorted.sort((a, b) => {
    switch (sort) {
      case 'title':
        return a.title.localeCompare(b.title);
      case 'priority':
        return PRIORITY_RANK[b.priority ?? 'none'] - PRIORITY_RANK[a.priority ?? 'none'];
      case 'due':
        return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
      case 'created':
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      default:
        return 0;
    }
  });
  return sorted;
}
