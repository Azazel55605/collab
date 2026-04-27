import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanBoard, KanbanCard } from '../../types/kanban';
import { CardDialogSidebar } from './CardDialogSidebar';

const DRAFT: KanbanCard = {
  id: 'card-1',
  title: 'Card',
  assignees: ['u1'],
  tags: [],
  comments: [],
  checklist: [],
  priority: 'high',
};

const BOARD: KanbanBoard = {
  columns: [
    { id: 'todo', title: 'Todo', cards: [] },
  ],
};

describe('CardDialogSidebar', () => {
  it('renders key metadata controls and triggers callbacks', () => {
    const patchDraft = vi.fn();
    const togglePriority = vi.fn();
    const toggleAssignee = vi.fn();
    const toggleArchive = vi.fn();
    const deleteCard = vi.fn();
    const setConfirmDelete = vi.fn();

    render(
      <CardDialogSidebar
        draft={DRAFT}
        priorities={[
          { value: 'high', label: 'High', active: 'active', inactive: 'inactive' },
          { value: 'medium', label: 'Medium', active: 'active', inactive: 'inactive' },
        ]}
        dateFormat="YYYY_MM_DD"
        knownUsers={[{ userId: 'u1', userName: 'User One', userColor: '#fff' }]}
        board={BOARD}
        currentColumnId="todo"
        confirmDelete={false}
        startDateOpen={false}
        dueDateOpen={false}
        setStartDateOpen={vi.fn()}
        setDueDateOpen={vi.fn()}
        setConfirmDelete={setConfirmDelete}
        togglePriority={togglePriority}
        patchDraft={patchDraft}
        toggleAssignee={toggleAssignee}
        moveToColumn={vi.fn()}
        toggleArchive={toggleArchive}
        deleteCard={deleteCard}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    expect(togglePriority).toHaveBeenCalledWith('high');

    fireEvent.click(screen.getByRole('button', { name: /clear priority/i }));
    expect(patchDraft).toHaveBeenCalledWith({ priority: undefined });

    fireEvent.click(screen.getByRole('button', { name: /user one/i }));
    expect(toggleAssignee).toHaveBeenCalledWith('u1');

    fireEvent.click(screen.getByRole('button', { name: /archive card/i }));
    expect(toggleArchive).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /delete card/i }));
    expect(setConfirmDelete).toHaveBeenCalledWith(true);
  });

  it('renders delete confirmation mode and allows cancel/delete actions', () => {
    const setConfirmDelete = vi.fn();
    const deleteCard = vi.fn();

    render(
      <CardDialogSidebar
        draft={{
          ...DRAFT,
          archived: true,
          archivedAt: new Date('2026-04-27T14:20:00Z').getTime(),
          archivedByUserName: 'User One',
        }}
        priorities={[]}
        dateFormat="YYYY_MM_DD"
        knownUsers={[]}
        board={BOARD}
        currentColumnId="todo"
        confirmDelete
        startDateOpen={false}
        dueDateOpen={false}
        setStartDateOpen={vi.fn()}
        setDueDateOpen={vi.fn()}
        setConfirmDelete={setConfirmDelete}
        togglePriority={vi.fn()}
        patchDraft={vi.fn()}
        toggleAssignee={vi.fn()}
        moveToColumn={vi.fn()}
        toggleArchive={vi.fn()}
        deleteCard={deleteCard}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /yes, delete/i }));
    expect(deleteCard).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(setConfirmDelete).toHaveBeenCalledWith(false);

    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('By')).toBeTruthy();
    expect(screen.getByText('User One')).toBeTruthy();
  });
});
