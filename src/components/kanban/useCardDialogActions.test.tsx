import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import {
  applyPromptTagsToBoard,
  deleteCardFromBoard,
  moveCardBetweenColumns,
  toggleArchivedCardInBoard,
  useCardDialogActions,
} from './useCardDialogActions';

const CARD: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  assignees: [],
  tags: ['existing'],
  comments: [],
  checklist: [],
};

const BOARD: KanbanBoard = {
  columns: [
    { id: 'todo', title: 'Todo', cards: [CARD] },
    { id: 'done', title: 'Done', autoComplete: true, defaultTags: ['done'], cards: [] },
  ],
};

describe('useCardDialogActions helpers', () => {
  it('deletes and archives cards within the targeted column', () => {
    expect(deleteCardFromBoard(BOARD, 'todo', 'card-1').columns[0].cards).toHaveLength(0);
    expect(toggleArchivedCardInBoard(BOARD, 'todo', 'card-1', false).columns[0].cards[0]).toEqual(
      expect.objectContaining({ archived: true, archivedColumnId: 'todo' }),
    );
  });

  it('moves cards between columns and requests prompt tags when needed', () => {
    const { nextBoard, destinationColumn, promptRequest } = moveCardBetweenColumns(BOARD, CARD, 'todo', 'done');

    expect(destinationColumn?.id).toBe('done');
    expect(nextBoard.columns[0].cards).toHaveLength(0);
    expect(nextBoard.columns[1].cards[0]).toEqual(
      expect.objectContaining({ id: 'card-1', isDone: true }),
    );
    expect(promptRequest).toEqual(
      expect.objectContaining({
        destinationColumnId: 'done',
        missingTags: ['done'],
      }),
    );
  });

  it('applies prompt tags to the destination column card', () => {
    const next = applyPromptTagsToBoard(BOARD, 'card-1', {
      destinationColumnId: 'done',
      destinationColumnTitle: 'Done',
      missingTags: ['done'],
    }, true);

    expect(next.columns[1].autoApplyDefaultTagsOnMove).toBe(true);
  });
});

describe('useCardDialogActions', () => {
  it('toggles done state and syncs the draft store', () => {
    const updateBoard = vi.fn();
    const storeUpdateDraft = vi.fn();
    const setCurrentColumnId = vi.fn();
    const cancelPendingFlush = vi.fn();
    const onClose = vi.fn();
    let draftState = CARD;
    const setDraft: React.Dispatch<React.SetStateAction<KanbanCard>> = (value) => {
      draftState = typeof value === 'function' ? value(draftState) : value;
    };

    const { result } = renderHook(() =>
      useCardDialogActions({
        board: BOARD,
        draft: draftState,
        setDraft,
        currentColIdRef: { current: 'todo' },
        setCurrentColumnId,
        updateBoard,
        storeUpdateDraft,
        cancelPendingFlush,
        onClose,
      }),
    );

    act(() => {
      result.current.toggleDone();
    });

    expect(cancelPendingFlush).toHaveBeenCalled();
    expect(storeUpdateDraft).toHaveBeenCalledWith(expect.objectContaining({ isDone: true }));
    expect(updateBoard).toHaveBeenCalledTimes(1);
  });
});
