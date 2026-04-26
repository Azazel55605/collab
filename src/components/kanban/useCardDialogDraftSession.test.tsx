import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import {
  applyCardDraftToBoard,
  createInitialCardDialogDraft,
  useCardDialogDraftSession,
} from './useCardDialogDraftSession';

const BASE_CARD: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  assignees: [],
  tags: [],
  comments: [],
  checklist: [],
};

describe('useCardDialogDraftSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('normalizes the initial draft from the stored draft when ids match', () => {
    const storedDraft: KanbanCard = {
      ...BASE_CARD,
      title: 'Stored',
      relativePath: 'Notes/a.md',
    };

    expect(createInitialCardDialogDraft(BASE_CARD, storedDraft)).toEqual(
      expect.objectContaining({
        title: 'Stored',
        attachmentPaths: ['Notes/a.md'],
        relativePath: 'Notes/a.md',
      }),
    );
  });

  it('replaces the matching card in the target column only', () => {
    const board: KanbanBoard = {
      columns: [
        { id: 'todo', title: 'Todo', cards: [BASE_CARD] },
        { id: 'done', title: 'Done', cards: [{ ...BASE_CARD, id: 'card-2', title: 'Other', assignees: [], tags: [], comments: [], checklist: [] }] },
      ],
    };

    const next = applyCardDraftToBoard(board, 'todo', { ...BASE_CARD, title: 'Updated' });

    expect(next.columns[0].cards[0].title).toBe('Updated');
    expect(next.columns[1].cards[0].title).toBe('Other');
  });

  it('patches the draft immediately and flushes the board update on debounce', () => {
    const updateBoard = vi.fn();
    const storeUpdateDraft = vi.fn();

    const { result } = renderHook(() =>
      useCardDialogDraftSession({
        initialCard: BASE_CARD,
        storedDraft: undefined,
        columnId: 'todo',
        updateBoard,
        storeUpdateDraft,
      }),
    );

    act(() => {
      result.current.patchDraft({ title: 'Updated title' });
    });

    expect(result.current.draft.title).toBe('Updated title');
    expect(storeUpdateDraft).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated title' }));
    expect(updateBoard).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(updateBoard).toHaveBeenCalledTimes(1);
    const updater = updateBoard.mock.calls[0][0] as (prev: KanbanBoard) => KanbanBoard;
    const nextBoard = updater({
      columns: [{ id: 'todo', title: 'Todo', cards: [BASE_CARD] }],
    });
    expect(nextBoard.columns[0].cards[0].title).toBe('Updated title');
  });
});
