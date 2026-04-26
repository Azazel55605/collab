import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import { CardDialogChecklistComments } from './CardDialogChecklistComments';

const DRAFT: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  assignees: [],
  tags: [],
  comments: [
    {
      id: 'comment-1',
      userId: 'me',
      userName: 'Me',
      userColor: '#fff',
      content: 'hello',
      timestamp: new Date('2025-01-01T12:00:00Z').getTime(),
    },
  ],
  checklist: [
    { id: 'item-1', text: 'Task', checked: false },
    { id: 'item-2', text: '', checked: true, cardRef: 'card-2' },
  ],
};

const BOARD: KanbanBoard = {
  columns: [
    { id: 'todo', title: 'Todo', cards: [{ id: 'card-2', title: 'Other Card', assignees: [], tags: [], comments: [], checklist: [], isDone: true }] },
  ],
};

describe('CardDialogChecklistComments', () => {
  it('handles checklist actions and linked-card picker actions', () => {
    const toggleChecklistItem = vi.fn();
    const updateChecklistText = vi.fn();
    const removeChecklistItem = vi.fn();
    const addChecklistItem = vi.fn();
    const addChecklistItemFromCard = vi.fn();

    render(
      <CardDialogChecklistComments
        draft={DRAFT}
        board={BOARD}
        checklistInput="New task"
        commentInput=""
        cardPickerOpen
        checklistDone={1}
        checklistTotal={2}
        myUserId="me"
        myUserName="Me"
        myUserColor="#fff"
        setChecklistInput={vi.fn()}
        setCommentInput={vi.fn()}
        setCardPickerOpen={vi.fn()}
        addChecklistItem={addChecklistItem}
        addChecklistItemFromCard={addChecklistItemFromCard}
        toggleChecklistItem={toggleChecklistItem}
        updateChecklistText={updateChecklistText}
        removeChecklistItem={removeChecklistItem}
        resolveCardTitle={() => 'Resolved Card'}
        addComment={vi.fn()}
        deleteComment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText(/mark task complete/i));
    expect(toggleChecklistItem).toHaveBeenCalledWith('item-1');

    fireEvent.change(screen.getByDisplayValue('Task'), { target: { value: 'Updated task' } });
    expect(updateChecklistText).toHaveBeenCalledWith('item-1', 'Updated task');

    fireEvent.click(screen.getByLabelText(/remove checklist item task/i));
    expect(removeChecklistItem).toHaveBeenCalledWith('item-1');

    fireEvent.keyDown(screen.getByPlaceholderText(/add subtask/i), { key: 'Enter' });
    expect(addChecklistItem).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Other Card'));
    expect(addChecklistItemFromCard).toHaveBeenCalledWith('card-2', 'Other Card');
  });

  it('handles comment posting and deletion', () => {
    const setCommentInput = vi.fn();
    const addComment = vi.fn();
    const deleteComment = vi.fn();

    render(
      <CardDialogChecklistComments
        draft={DRAFT}
        board={BOARD}
        checklistInput=""
        commentInput="hello"
        cardPickerOpen={false}
        checklistDone={1}
        checklistTotal={2}
        myUserId="me"
        myUserName="Me"
        myUserColor="#fff"
        setChecklistInput={vi.fn()}
        setCommentInput={setCommentInput}
        setCardPickerOpen={vi.fn()}
        addChecklistItem={vi.fn()}
        addChecklistItemFromCard={vi.fn()}
        toggleChecklistItem={vi.fn()}
        updateChecklistText={vi.fn()}
        removeChecklistItem={vi.fn()}
        resolveCardTitle={() => 'Resolved Card'}
        addComment={addComment}
        deleteComment={deleteComment}
      />,
    );

    fireEvent.click(screen.getByLabelText(/delete comment hello/i));
    expect(deleteComment).toHaveBeenCalledWith('comment-1');

    fireEvent.change(screen.getByPlaceholderText(/add comment/i), { target: { value: 'updated' } });
    expect(setCommentInput).toHaveBeenCalledWith('updated');

    fireEvent.click(screen.getByRole('button', { name: /post/i }));
    expect(addComment).toHaveBeenCalled();
  });
});
