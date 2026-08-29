import { describe, expect, it } from 'vitest';

import {
  applyCalendarPatchToKanban,
  calendarTaskToKanbanPatch,
  projectLocalKanbanCalendar,
} from './kanbanCalendarProjection';

const board = {
  columns: [
    {
      id: 'todo',
      title: 'Todo',
      cards: [
        {
          id: 'assigned',
          title: 'Assigned task',
          description: 'Source-owned details',
          assignees: ['profile-1'],
          tags: [],
          comments: [],
          checklist: [],
          startDate: '2026-07-24',
          dueDate: '2026-07-25',
          recurrence: { enabled: true, mode: 'weekly' as const, interval: 2, weekdays: [1, 4] },
        },
        {
          id: 'other-user',
          title: 'Private task',
          assignees: ['profile-2'],
          tags: [],
          comments: [],
          checklist: [],
        },
        {
          id: 'archived',
          title: 'Archived task',
          assignees: ['profile-1'],
          tags: [],
          comments: [],
          checklist: [],
          archived: true,
        },
      ],
    },
  ],
};

describe('Kanban calendar projection', () => {
  it('projects only active assignments with stable source links and recurrence', () => {
    const first = projectLocalKanbanCalendar({
      profileId: 'profile-1',
      originKey: 'local-vault:/vault',
      vaultName: 'Project',
      now: '2026-07-24T08:00:00.000Z',
      sources: [
        {
          fileId: 'Board.kanban',
          path: 'Board.kanban',
          sourceRevision: 12,
          content: JSON.stringify(board),
        },
      ],
    });
    const second = projectLocalKanbanCalendar({
      profileId: 'profile-1',
      originKey: 'local-vault:/vault',
      vaultName: 'Project',
      now: '2026-07-24T09:00:00.000Z',
      sources: [
        {
          fileId: 'Board.kanban',
          path: 'Board.kanban',
          sourceRevision: 12,
          content: JSON.stringify(board),
        },
      ],
    });

    expect(first.calendar).toMatchObject({
      id: second.calendar.id,
      name: 'Assigned tasks · Project',
      location: { kind: 'kanban', originKey: 'local-vault:/vault' },
      readOnly: true,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: second.items[0].id,
      title: 'Assigned task',
      recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH' },
      sourceBinding: {
        kind: 'kanban',
        fileId: 'Board.kanban',
        cardId: 'assigned',
        path: 'Board.kanban',
        sourceRevision: 12,
      },
    });
  });

  it('round-trips the narrow editable task fields without changing source-owned content', () => {
    const projection = projectLocalKanbanCalendar({
      profileId: 'profile-1',
      originKey: 'local-vault:/vault',
      vaultName: 'Project',
      now: '2026-07-24T08:00:00.000Z',
      sources: [
        {
          fileId: 'Board.kanban',
          path: 'Board.kanban',
          sourceRevision: 12,
          content: JSON.stringify(board),
        },
      ],
    });
    const edited = {
      ...projection.items[0],
      start: undefined,
      due: { kind: 'date' as const, date: '2026-08-01' },
      status: 'completed' as const,
      recurrence: { rrule: 'FREQ=MONTHLY;INTERVAL=1' },
    };
    const patched = applyCalendarPatchToKanban(
      board,
      'assigned',
      calendarTaskToKanbanPatch(edited),
    );
    const card = patched.columns[0].cards[0];

    expect(card).toMatchObject({
      id: 'assigned',
      title: 'Assigned task',
      description: 'Source-owned details',
      dueDate: '2026-08-01',
      isDone: true,
      recurrence: { enabled: true, mode: 'monthly', interval: 1 },
    });
    expect(card.startDate).toBeUndefined();
    expect(card.assignees).toEqual(['profile-1']);
  });
});
