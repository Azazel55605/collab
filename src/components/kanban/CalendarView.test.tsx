import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';

import CalendarView from './CalendarView';

const useKanbanContextMock = vi.fn();

vi.mock('../../views/KanbanPage', () => ({
  useKanbanContext: () => useKanbanContextMock(),
}));

vi.mock('./CardDialog', () => ({
  default: () => null,
}));

vi.mock('../ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/calendar', () => ({
  Calendar: () => null,
}));

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

describe('CalendarView year overview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));

    useUiStore.setState({
      dateFormat: 'MMM_D_YYYY',
      weekStart: 1,
    });

    useKanbanContextMock.mockReturnValue({
      relativePath: 'Boards/project.kanban',
      updateBoard: vi.fn(),
      knownUsers: [{ userId: 'user-1', userName: 'Alex', userColor: '#22c55e' }],
      board: {
        columns: [
          {
            id: 'todo',
            title: 'Todo',
            color: '#60a5fa',
            hideFromTimeline: true,
            cards: [
              {
                id: 'active-1',
                title: 'Active January task',
                assignees: ['user-1'],
                startDate: '2026-01-10',
                dueDate: '2026-01-12',
              },
              {
                id: 'archived-1',
                title: 'Archived January task',
                assignees: ['user-1'],
                startDate: '2026-01-15',
                dueDate: '2026-01-16',
                archived: true,
                archivedAt: new Date('2026-01-15T12:00:00Z').getTime(),
              },
            ],
          },
        ],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('includes hidden-column tasks in the year tiles by default and can toggle them off', () => {
    render(<CalendarView />);

    fireEvent.click(screen.getByText('Yr'));

    const januaryTile = screen.getByText('Jan').closest('button');
    expect(januaryTile).toBeTruthy();
    expect(within(januaryTile as HTMLElement).getByText(/2 total/)).toBeTruthy();
    expect(within(januaryTile as HTMLElement).getByText('Active 1')).toBeTruthy();
    expect(within(januaryTile as HTMLElement).getByText('Archived 1')).toBeTruthy();

    fireEvent.click(screen.getByText('Including hidden columns'));

    expect(within(januaryTile as HTMLElement).getByText(/0 total/)).toBeTruthy();
    expect(within(januaryTile as HTMLElement).getByText('Active 0')).toBeTruthy();
    expect(within(januaryTile as HTMLElement).getByText('Archived 0')).toBeTruthy();
  });
});
