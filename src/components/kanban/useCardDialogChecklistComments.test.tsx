import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import {
  addCardComment,
  addChecklistEntry,
  removeCardComment,
  removeChecklistEntry,
  resolveChecklistCardTitle,
  toggleChecklistEntry,
  updateChecklistEntryText,
  useCardDialogChecklistComments,
} from './useCardDialogChecklistComments';

const CARD: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  assignees: [],
  tags: [],
  comments: [],
  checklist: [],
};

const BOARD: KanbanBoard = {
  columns: [
    { id: 'todo', title: 'Todo', cards: [CARD] },
    { id: 'done', title: 'Done', cards: [{ ...CARD, id: 'card-2', title: 'Other card' }] },
  ],
};

describe('useCardDialogChecklistComments helpers', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
    vi.spyOn(Date, 'now').mockReturnValue(1234);
  });

  it('adds, toggles, updates, and removes checklist entries', () => {
    const added = addChecklistEntry([], ' Task ');
    expect(added[0]).toEqual(expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', text: 'Task', checked: false }));
    expect(toggleChecklistEntry(added, '00000000-0000-0000-0000-000000000001')[0].checked).toBe(true);
    expect(updateChecklistEntryText(added, '00000000-0000-0000-0000-000000000001', 'Updated')[0].text).toBe('Updated');
    expect(removeChecklistEntry(added, '00000000-0000-0000-0000-000000000001')).toEqual([]);
  });

  it('adds and removes comments and resolves linked card titles', () => {
    const comments = addCardComment([], ' Hello ', { userId: 'u1', userName: 'User', userColor: '#fff' });
    expect(comments[0]).toEqual(expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', content: 'Hello', timestamp: 1234 }));
    expect(removeCardComment(comments, '00000000-0000-0000-0000-000000000001')).toEqual([]);
    expect(resolveChecklistCardTitle(BOARD, 'card-2')).toBe('Other card');
    expect(resolveChecklistCardTitle(BOARD, 'missing')).toBe('(deleted card)');
  });
});

describe('useCardDialogChecklistComments', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
    vi.spyOn(Date, 'now').mockReturnValue(1234);
  });

  it('updates checklist and comment state through patchDraft', () => {
    const patchDraft = vi.fn();
    const { result } = renderHook(() =>
      useCardDialogChecklistComments({
        board: BOARD,
        draft: CARD,
        patchDraft,
        myUserId: 'u1',
        myUserName: 'User',
        myUserColor: '#fff',
      }),
    );

    act(() => {
      result.current.setChecklistInput('Task');
    });
    act(() => {
      result.current.addChecklistItem();
    });
    expect(patchDraft).toHaveBeenCalledWith({
      checklist: [expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', text: 'Task' })],
    });

    act(() => {
      result.current.setCommentInput('Hello');
    });
    act(() => {
      result.current.addComment();
    });
    expect(patchDraft).toHaveBeenCalledWith({
      comments: [expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', content: 'Hello' })],
    });
  });
});
