import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createCard, type KanbanBoard } from '../lib/kanban';

import { MobileCalendarView, MobileTimelineView } from './KanbanScreen';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function scheduledBoard(): KanbanBoard {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    columns: [
      {
        id: 'doing',
        title: 'Doing',
        color: '#22c55e',
        cards: [
          {
            ...createCard('Scheduled task'),
            id: 'task-1',
            startDate: dateKey(today),
            dueDate: dateKey(tomorrow),
          },
        ],
      },
    ],
  };
}

describe('mobile Kanban alternate views', () => {
  it('shows scheduled tasks as calendar dots and reveals the selected day agenda', () => {
    const openCard = vi.fn();
    const { container } = render(
      <MobileCalendarView board={scheduledBoard()} onOpenCard={openCard} />,
    );

    expect(container.querySelectorAll('.mobile-calendar-dots i').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Scheduled task'));
    expect(openCard).toHaveBeenCalledWith('task-1');
  });

  it('renders scheduled cards as positioned timeline bars', () => {
    const openCard = vi.fn();
    const { container } = render(
      <MobileTimelineView board={scheduledBoard()} onOpenCard={openCard} />,
    );

    expect(container.querySelector('.mobile-timeline-bar')).not.toBeNull();
    fireEvent.click(screen.getByText('Scheduled task'));
    expect(openCard).toHaveBeenCalledWith('task-1');
  });
});
