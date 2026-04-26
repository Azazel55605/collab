import { useMemo, useState } from 'react';

import type { KanbanBoard, KanbanCard, KanbanComment, ChecklistItem } from '../../types/kanban';

type UseCardDialogChecklistCommentsArgs = {
  board: KanbanBoard;
  draft: KanbanCard;
  patchDraft: (changes: Partial<KanbanCard>) => void;
  myUserId: string;
  myUserName: string;
  myUserColor: string;
};

export function resolveChecklistCardTitle(board: KanbanBoard, cardId: string): string {
  for (const column of board.columns) {
    const found = column.cards.find((card) => card.id === cardId);
    if (found) return found.title;
  }
  return '(deleted card)';
}

export function addChecklistEntry(checklist: ChecklistItem[], text: string, cardRef?: string): ChecklistItem[] {
  const trimmed = text.trim();
  if (!trimmed) return checklist;
  const item: ChecklistItem = {
    id: crypto.randomUUID(),
    text: trimmed,
    checked: false,
    ...(cardRef ? { cardRef } : {}),
  };
  return [...checklist, item];
}

export function toggleChecklistEntry(checklist: ChecklistItem[], id: string): ChecklistItem[] {
  return checklist.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item));
}

export function updateChecklistEntryText(checklist: ChecklistItem[], id: string, text: string): ChecklistItem[] {
  return checklist.map((item) => (item.id === id ? { ...item, text } : item));
}

export function removeChecklistEntry(checklist: ChecklistItem[], id: string): ChecklistItem[] {
  return checklist.filter((item) => item.id !== id);
}

export function addCardComment(
  comments: KanbanComment[],
  content: string,
  author: { userId: string; userName: string; userColor: string },
): KanbanComment[] {
  const trimmed = content.trim();
  if (!trimmed) return comments;
  return [
    ...comments,
    {
      id: crypto.randomUUID(),
      userId: author.userId,
      userName: author.userName,
      userColor: author.userColor,
      content: trimmed,
      timestamp: Date.now(),
    },
  ];
}

export function removeCardComment(comments: KanbanComment[], id: string): KanbanComment[] {
  return comments.filter((comment) => comment.id !== id);
}

export function useCardDialogChecklistComments({
  board,
  draft,
  patchDraft,
  myUserId,
  myUserName,
  myUserColor,
}: UseCardDialogChecklistCommentsArgs) {
  const [commentInput, setCommentInput] = useState('');
  const [checklistInput, setChecklistInput] = useState('');
  const [cardPickerOpen, setCardPickerOpen] = useState(false);

  function addChecklistItem() {
    const nextChecklist = addChecklistEntry(draft.checklist, checklistInput);
    if (nextChecklist === draft.checklist) return;
    patchDraft({ checklist: nextChecklist });
    setChecklistInput('');
  }

  function addChecklistItemFromCard(cardId: string, cardTitle: string) {
    setCardPickerOpen(false);
    patchDraft({ checklist: addChecklistEntry(draft.checklist, cardTitle, cardId) });
  }

  function toggleChecklistItem(id: string) {
    patchDraft({ checklist: toggleChecklistEntry(draft.checklist, id) });
  }

  function updateChecklistText(id: string, text: string) {
    patchDraft({ checklist: updateChecklistEntryText(draft.checklist, id, text) });
  }

  function removeChecklistItem(id: string) {
    patchDraft({ checklist: removeChecklistEntry(draft.checklist, id) });
  }

  function addComment() {
    const nextComments = addCardComment(draft.comments, commentInput, {
      userId: myUserId,
      userName: myUserName,
      userColor: myUserColor,
    });
    if (nextComments === draft.comments) return;
    setCommentInput('');
    patchDraft({ comments: nextComments });
  }

  function deleteComment(id: string) {
    patchDraft({ comments: removeCardComment(draft.comments, id) });
  }

  const checklistDone = useMemo(
    () => draft.checklist.filter((item) => item.checked).length,
    [draft.checklist],
  );
  const checklistTotal = draft.checklist.length;

  return {
    commentInput,
    setCommentInput,
    checklistInput,
    setChecklistInput,
    cardPickerOpen,
    setCardPickerOpen,
    addChecklistItem,
    addChecklistItemFromCard,
    toggleChecklistItem,
    updateChecklistText,
    removeChecklistItem,
    resolveCardTitle: (cardId: string) => resolveChecklistCardTitle(board, cardId),
    addComment,
    deleteComment,
    checklistDone,
    checklistTotal,
  };
}
