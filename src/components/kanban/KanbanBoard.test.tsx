import type { ReactNode } from 'react';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KanbanBoard } from '../../types/kanban';
import { useCollabStore } from '../../store/collabStore';
import { useKanbanStore } from '../../store/kanbanStore';

import KanbanBoardView from './KanbanBoard';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  PointerSensor: function PointerSensor() {},
  closestCorners: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
}));

vi.mock('./KanbanColumn', () => ({
  default: ({ column }: { column: { title: string } }) => <div>{column.title}</div>,
}));

vi.mock('./KanbanCard', () => ({
  default: () => <div>card-overlay</div>,
}));

vi.mock('./CalendarView', () => ({
  default: () => <div>calendar-view</div>,
}));

vi.mock('./TimelineView', () => ({
  default: () => <div>timeline-view</div>,
}));

vi.mock('./CardDialog', () => ({
  default: ({ card }: { card: { title: string } }) => <div>Dialog for {card.title}</div>,
}));

vi.mock('../layout/DocumentTopBar', () => ({
  DocumentTopBar: ({
    title,
    meta,
    secondary,
  }: {
    title: string;
    meta?: ReactNode;
    secondary?: ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{meta}</div>
      <div>{secondary}</div>
    </div>
  ),
  documentTopBarGroupClass: 'group',
  getDocumentBaseName: () => 'Test Board',
  getDocumentFolderPath: () => 'Boards',
}));

let kanbanContext: {
  board: KanbanBoard;
  updateBoard: (updater: (prev: KanbanBoard) => KanbanBoard) => void;
  relativePath: string;
  knownUsers: Array<{ userId: string; userName: string; userColor: string }>;
};

vi.mock('../../views/KanbanPage', () => ({
  useKanbanContext: () => kanbanContext,
}));

const INITIAL_BOARD: KanbanBoard = {
  columns: [
    {
      id: 'todo',
      title: 'To Do',
      color: '#64748b',
      cards: [
        {
          id: 'card-1',
          title: 'Archived task',
          assignees: ['user-2'],
          tags: [],
          comments: [],
          checklist: [{ id: 'check-1', text: 'Review', checked: true }],
          attachmentPaths: ['Files/spec.pdf'],
          priority: 'high',
          startDate: '2026-04-20',
          dueDate: '2026-04-30',
          archived: true,
          archivedColumnId: 'todo',
          archivedAt: new Date('2026-04-27T14:20:00Z').getTime(),
          archivedByUserId: 'user-1',
          archivedByUserName: 'Test User',
        },
        {
          id: 'card-2',
          title: 'Second archived bug',
          assignees: [],
          tags: ['bug'],
          comments: [],
          checklist: [],
          archived: true,
          archivedColumnId: 'todo',
          archivedAt: new Date('2026-04-26T09:00:00Z').getTime(),
          archivedByUserId: 'user-1',
          archivedByUserName: 'Test User',
        },
      ],
    },
  ],
};

function Harness() {
  const [board, setBoard] = useState<KanbanBoard>(INITIAL_BOARD);
  kanbanContext = {
    board,
    updateBoard: (updater) => setBoard((prev) => updater(prev)),
    relativePath: 'Boards/test.kanban',
    knownUsers: [{ userId: 'user-2', userName: 'Alex Doe', userColor: '#60a5fa' }],
  };

  return <KanbanBoardView />;
}

describe('KanbanBoard archive view', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      boardPath: null,
      cardId: null,
      columnId: null,
      draft: null,
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      myRole: null,
      peers: [],
      conflicts: [],
      chatMessages: [],
      chatTypingUntil: null,
    });
  });

  it('shows archived cards in a dedicated archive view and opens them for editing', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /archive2/i }));

    expect(screen.getByText('Archived task')).toBeTruthy();
    expect(screen.getAllByText(/archived by test user/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/high/i)).toBeTruthy();
    expect(screen.getByText(/alex doe/i)).toBeTruthy();
    expect(screen.getAllByText((_, element) => element?.textContent?.startsWith('Start ') ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent?.startsWith('Due ') ?? false).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 attachment/i)).toBeTruthy();
    expect(screen.getByText(/1\/1 tasks/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /archived task/i }));

    expect(screen.getByText('Dialog for Archived task')).toBeTruthy();
  });

  it('filters archived cards through the search bar', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /archive2/i }));

    const search = screen.getByPlaceholderText(/search archived cards/i);
    fireEvent.change(search, { target: { value: 'second' } });

    expect(screen.getByText('Second archived bug')).toBeTruthy();
    expect(screen.queryByText('Archived task')).toBeNull();
  });
});
