import { useState } from 'react';

import {
  getMissingColumnDefaultTags,
  mergeUniqueTags,
  setCardDoneState,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
} from '../../types/kanban';

type UpdateBoard = (updater: (prev: KanbanBoard) => KanbanBoard) => void;

export interface MoveTagsPromptState {
  destinationColumnId: string;
  destinationColumnTitle: string;
  missingTags: string[];
}

type UseCardDialogActionsArgs = {
  board: KanbanBoard;
  draft: KanbanCard;
  myUserId: string;
  myUserName: string;
  setDraft: React.Dispatch<React.SetStateAction<KanbanCard>>;
  currentColIdRef: React.MutableRefObject<string>;
  setCurrentColumnId: (columnId: string) => void;
  updateBoard: UpdateBoard;
  storeUpdateDraft: (draft: KanbanCard) => void;
  cancelPendingFlush: () => void;
  onClose: () => void;
};

export function deleteCardFromBoard(board: KanbanBoard, columnId: string, cardId: string): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) =>
      column.id !== columnId
        ? column
        : {
            ...column,
            cards: column.cards.filter((card) => card.id !== cardId),
          },
    ),
  };
}

export function toggleArchivedCardInBoard(
  board: KanbanBoard,
  columnId: string,
  cardId: string,
  isArchived: boolean | undefined,
  actor?: { userId: string; userName: string },
): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) =>
      column.id !== columnId
        ? column
        : {
            ...column,
            cards: column.cards.map((card) =>
              card.id !== cardId
                ? card
                : {
                    ...card,
                    archived: isArchived ? undefined : true,
                    archivedColumnId: isArchived ? undefined : columnId,
                    archivedAt: isArchived ? undefined : Date.now(),
                    archivedByUserId: isArchived ? undefined : actor?.userId,
                    archivedByUserName: isArchived ? undefined : actor?.userName,
                  },
            ),
          },
    ),
  };
}

export function applyPromptTagsToBoard(
  board: KanbanBoard,
  draftId: string,
  prompt: MoveTagsPromptState,
  enableAutoApply: boolean,
): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => {
      if (column.id !== prompt.destinationColumnId) return column;
      return {
        ...column,
        autoApplyDefaultTagsOnMove: enableAutoApply ? true : column.autoApplyDefaultTagsOnMove,
        cards: column.cards.map((entry) => (
          entry.id !== draftId
            ? entry
            : { ...entry, tags: mergeUniqueTags(entry.tags, prompt.missingTags) }
        )),
      };
    }),
  };
}

export function moveCardBetweenColumns(
  board: KanbanBoard,
  draft: KanbanCard,
  sourceColumnId: string,
  destinationColumnId: string,
): {
  nextBoard: KanbanBoard;
  destinationColumn?: KanbanColumn;
  promptRequest: MoveTagsPromptState | null;
} {
  const destinationColumn = board.columns.find((column) => column.id === destinationColumnId);
  const sourceColumn = board.columns.find((column) => column.id === sourceColumnId);
  if (!sourceColumn || !destinationColumn) {
    return { nextBoard: board, destinationColumn, promptRequest: null };
  }

  const card = sourceColumn.cards.find((entry) => entry.id === draft.id);
  if (!card) {
    return { nextBoard: board, destinationColumn, promptRequest: null };
  }

  const missingTags = getMissingColumnDefaultTags(draft, destinationColumn);
  const shouldAutoApplyTags = destinationColumn.autoApplyDefaultTagsOnMove;
  const promptRequest = missingTags.length > 0 && !shouldAutoApplyTags
    ? {
        destinationColumnId: destinationColumn.id,
        destinationColumnTitle: destinationColumn.title,
        missingTags,
      }
    : null;

  const movedCard = {
    ...draft,
    isDone: destinationColumn.autoComplete ? true : draft.isDone,
    tags: shouldAutoApplyTags ? mergeUniqueTags(draft.tags, missingTags) : draft.tags,
  };
  const nextBoard = setCardDoneState({
    ...board,
    columns: board.columns.map((column) => {
      if (column.id === sourceColumnId) {
        return { ...column, cards: column.cards.filter((entry) => entry.id !== draft.id) };
      }
      if (column.id === destinationColumnId) {
        return { ...column, cards: [...column.cards, movedCard] };
      }
      return column;
    }),
  }, draft.id, movedCard.isDone ?? false);

  return {
    nextBoard,
    destinationColumn,
    promptRequest,
  };
}

export function useCardDialogActions({
  board,
  draft,
  myUserId,
  myUserName,
  setDraft,
  currentColIdRef,
  setCurrentColumnId,
  updateBoard,
  storeUpdateDraft,
  cancelPendingFlush,
  onClose,
}: UseCardDialogActionsArgs) {
  const [moveTagsPrompt, setMoveTagsPrompt] = useState<MoveTagsPromptState | null>(null);

  function deleteCard() {
    updateBoard((prev) => deleteCardFromBoard(prev, currentColIdRef.current, draft.id));
    onClose();
  }

  function moveToColumn(newColId: string) {
    if (newColId === currentColIdRef.current) return;

    cancelPendingFlush();
    const sourceColId = currentColIdRef.current;
    const { nextBoard, destinationColumn, promptRequest } = moveCardBetweenColumns(board, draft, sourceColId, newColId);
    updateBoard(() => nextBoard);

    currentColIdRef.current = newColId;
    setCurrentColumnId(newColId);
    setDraft((prev) => {
      const next = {
        ...prev,
        isDone: destinationColumn?.autoComplete ? true : prev.isDone,
        tags: destinationColumn?.autoApplyDefaultTagsOnMove
          ? mergeUniqueTags(prev.tags, getMissingColumnDefaultTags(prev, destinationColumn))
          : prev.tags,
      };
      storeUpdateDraft(next);
      return next;
    });
    if (promptRequest) {
      setMoveTagsPrompt(promptRequest);
    }
  }

  function applyPromptTags(enableAutoApply: boolean) {
    if (!moveTagsPrompt) return;
    updateBoard((prev) => applyPromptTagsToBoard(prev, draft.id, moveTagsPrompt, enableAutoApply));
    setDraft((prev) => ({ ...prev, tags: mergeUniqueTags(prev.tags, moveTagsPrompt.missingTags) }));
    setMoveTagsPrompt(null);
  }

  function toggleArchive() {
    cancelPendingFlush();
    updateBoard((prev) => toggleArchivedCardInBoard(
      prev,
      currentColIdRef.current,
      draft.id,
      draft.archived,
      { userId: myUserId, userName: myUserName },
    ));
    onClose();
  }

  function toggleDone() {
    const nextIsDone = !draft.isDone;
    cancelPendingFlush();
    updateBoard((prev) => setCardDoneState(prev, draft.id, nextIsDone));
    setDraft((prev) => {
      const next = { ...prev, isDone: nextIsDone };
      storeUpdateDraft(next);
      return next;
    });
  }

  return {
    moveTagsPrompt,
    setMoveTagsPrompt,
    deleteCard,
    moveToColumn,
    applyPromptTags,
    toggleArchive,
    toggleDone,
  };
}
