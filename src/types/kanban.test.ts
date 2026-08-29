import { describe, expect, it } from 'vitest';

import {
  applyCardSwimlaneValue,
  getFilteredBoard,
  getKanbanBoardStats,
  getKanbanSwimlanes,
  type KanbanBoard,
  normalizeKanbanBoard,
  runKanbanAutomations,
  setCardDoneState,
} from './kanban';

function makeBoard(): KanbanBoard {
  return normalizeKanbanBoard({
    columns: [
      {
        id: 'todo',
        title: 'To Do',
        cards: [
          {
            id: 'card-1',
            title: 'Recurring task',
            assignees: ['user-1'],
            tags: ['ops', 'urgent'],
            startDate: '2026-04-29',
            dueDate: '2026-04-30',
            comments: [
              {
                id: 'comment-1',
                userId: 'user-1',
                userName: 'Ada',
                userColor: '#fff',
                content: 'note',
                timestamp: 1,
              },
            ],
            checklist: [{ id: 'check-1', text: 'Ship it', checked: true }],
            recurrence: {
              enabled: true,
              mode: 'weekly',
              interval: 1,
              anchor: 'dueDate',
              preserveChecklist: false,
            },
          },
          {
            id: 'card-2',
            title: 'Bug triage',
            assignees: [],
            tags: ['bug'],
            dueDate: '2026-05-01',
            comments: [],
            checklist: [],
            priority: 'high',
          },
        ],
      },
      {
        id: 'review',
        title: 'Review',
        cards: [],
      },
    ],
    automations: [
      {
        id: 'rule-1',
        name: 'Move overdue cards to review',
        enabled: true,
        trigger: 'manual',
        condition: { overdue: true },
        action: { type: 'moveToColumn', columnId: 'review' },
      },
    ],
  });
}

describe('kanban helpers', () => {
  it('creates the next occurrence when a recurring card is completed', () => {
    const board = makeBoard();
    const next = setCardDoneState(board, 'card-1', true);
    const todo = next.columns.find((column) => column.id === 'todo');
    expect(todo?.cards).toHaveLength(3);

    const original = todo?.cards.find((card) => card.id === 'card-1');
    const spawned = todo?.cards.find(
      (card) => card.id !== 'card-1' && card.title === 'Recurring task',
    );

    expect(original?.isDone).toBe(true);
    expect(original?.completedAt).toBeTypeOf('number');
    expect(spawned?.comments).toHaveLength(0);
    expect(spawned?.checklist[0]?.checked).toBe(false);
    expect(spawned?.dueDate).toBe('2026-05-07');
    expect(spawned?.startDate).toBe('2026-05-06');
  });

  it('filters cards by query, tags, and archive inclusion', () => {
    const board = makeBoard();
    board.columns[0].cards[1].archived = true;

    const filtered = getFilteredBoard(board, {
      query: 'recurring',
      tagsAny: ['urgent'],
      includeArchived: false,
    });

    expect(filtered.columns[0].cards.map((card) => card.id)).toEqual(['card-1']);
  });

  it('runs manual automations once per pass', () => {
    const board = makeBoard();
    board.columns[0].cards[0].dueDate = '2026-04-20';
    board.columns[0].cards[1].dueDate = '2026-04-22';

    const next = runKanbanAutomations(board, 'manual', new Date('2026-04-30T12:00:00Z').getTime());

    expect(next.columns.find((column) => column.id === 'todo')?.cards).toHaveLength(0);
    expect(
      next.columns.find((column) => column.id === 'review')?.cards.map((card) => card.id),
    ).toEqual(['card-1', 'card-2']);
  });

  it('derives board stats from runtime board state', () => {
    const board = makeBoard();
    board.columns[0].cards[0].isDone = true;
    board.columns[0].cards[1].archived = true;

    const stats = getKanbanBoardStats(board, new Date('2026-04-30T12:00:00Z'));

    expect(stats.totalActiveCards).toBe(1);
    expect(stats.completedCount).toBe(1);
    expect(stats.archivedCount).toBe(1);
    expect(stats.dueTodayCount).toBe(1);
    expect(stats.checklistCompletion).toEqual({ completed: 1, total: 1 });
  });

  it('groups cards into single swimlanes and mutates lane-owned fields', () => {
    const board = makeBoard();
    const lanes = getKanbanSwimlanes(board.columns[0].cards, 'assignee', [
      { userId: 'user-1', userName: 'Ada' },
    ]);

    expect(lanes.map((lane) => lane.title)).toContain('Ada');
    expect(lanes.flatMap((lane) => lane.cards).filter((card) => card.id === 'card-1')).toHaveLength(
      1,
    );

    const reprioritized = applyCardSwimlaneValue(board, 'card-1', 'todo', 'priority', 'low');
    expect(reprioritized.columns[0].cards[0].priority).toBe('low');

    const unassigned = applyCardSwimlaneValue(board, 'card-1', 'todo', 'assignee', null);
    expect(unassigned.columns[0].cards[0].assignees).toEqual([]);
  });
});
