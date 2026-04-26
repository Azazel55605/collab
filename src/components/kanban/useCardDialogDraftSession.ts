import { useCallback, useEffect, useRef, useState } from 'react';

import { getCardAttachmentPaths, type KanbanBoard, type KanbanCard } from '../../types/kanban';

type UpdateBoard = (updater: (prev: KanbanBoard) => KanbanBoard) => void;

type UseCardDialogDraftSessionArgs = {
  initialCard: KanbanCard;
  storedDraft?: KanbanCard | null;
  columnId: string;
  updateBoard: UpdateBoard;
  storeUpdateDraft: (draft: KanbanCard) => void;
  debounceMs?: number;
};

export function createInitialCardDialogDraft(initialCard: KanbanCard, storedDraft?: KanbanCard | null): KanbanCard {
  const base = storedDraft && storedDraft.id === initialCard.id ? storedDraft : initialCard;
  return {
    ...base,
    checklist: base.checklist ?? [],
    attachmentPaths: getCardAttachmentPaths(base),
    relativePath: getCardAttachmentPaths(base)[0],
  };
}

export function applyCardDraftToBoard(board: KanbanBoard, columnId: string, draft: KanbanCard): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) =>
      column.id !== columnId
        ? column
        : {
            ...column,
            cards: column.cards.map((card) => (card.id !== draft.id ? card : draft)),
          },
    ),
  };
}

export function useCardDialogDraftSession({
  initialCard,
  storedDraft,
  columnId,
  updateBoard,
  storeUpdateDraft,
  debounceMs = 300,
}: UseCardDialogDraftSessionArgs) {
  const [draft, setDraft] = useState<KanbanCard>(() => createInitialCardDialogDraft(initialCard, storedDraft));
  const [currentColumnId, setCurrentColumnId] = useState(columnId);
  const currentColIdRef = useRef(columnId);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelPendingFlush = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
  }, []);

  const flushDraft = useCallback((nextDraft: KanbanCard) => {
    cancelPendingFlush();
    const targetColumnId = currentColIdRef.current;
    saveTimerRef.current = setTimeout(() => {
      updateBoard((prev) => applyCardDraftToBoard(prev, targetColumnId, nextDraft));
      saveTimerRef.current = undefined;
    }, debounceMs);
  }, [cancelPendingFlush, debounceMs, updateBoard]);

  const patchDraft = useCallback((changes: Partial<KanbanCard>) => {
    setDraft((prev) => {
      const next = { ...prev, ...changes };
      flushDraft(next);
      storeUpdateDraft(next);
      return next;
    });
  }, [flushDraft, storeUpdateDraft]);

  useEffect(() => () => {
    cancelPendingFlush();
  }, [cancelPendingFlush]);

  return {
    draft,
    setDraft,
    patchDraft,
    currentColumnId,
    setCurrentColumnId,
    currentColIdRef,
    saveTimerRef,
    flushDraft,
    cancelPendingFlush,
  };
}
