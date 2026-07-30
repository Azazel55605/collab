import { describe, expect, it } from 'vitest';

import { sheetCellKey } from '../../types/sheet';
import { createEmptySheetDocument } from './document';
import {
  applySheetDataSnapshot,
  calendarItemSnapshot,
  kanbanTaskSnapshot,
  refreshSheetDataSnapshot,
} from './dataConnections';

describe('sheet data snapshots', () => {
  it('materializes and refreshes a Kanban task snapshot without leaving stale rows', () => {
    let document = createEmptySheetDocument('Tasks', {
      worksheet: { id: 'ws1', rows: 4, columns: 2 },
    });
    const first = kanbanTaskSnapshot(JSON.stringify({
      columns: [{
        id: 'todo',
        title: 'Todo',
        cards: [
          { id: 'a', title: 'One', assignees: [], tags: [], comments: [], checklist: [] },
          { id: 'b', title: 'Two', assignees: [], tags: [], comments: [], checklist: [] },
        ],
      }],
    }), 'Project.kanban');
    document = applySheetDataSnapshot(document, 'ws1', { row: 0, column: 0 }, first);
    const connection = document.dataConnections![0];
    expect(connection.itemCount).toBe(2);
    expect(document.worksheets[0].columnOrder.length).toBeGreaterThanOrEqual(6);

    const second = kanbanTaskSnapshot(JSON.stringify({
      columns: [{
        id: 'todo',
        title: 'Todo',
        cards: [{ id: 'b', title: 'Two updated', assignees: [], tags: [], comments: [], checklist: [] }],
      }],
    }), 'Project.kanban');
    document = refreshSheetDataSnapshot(document, connection.id, second);
    const worksheet = document.worksheets[0];
    expect(document.dataConnections![0].itemCount).toBe(1);
    expect(worksheet.cells[sheetCellKey(worksheet.rowOrder[1], worksheet.columnOrder[0])].value)
      .toBe('Two updated');
    expect(worksheet.cells[sheetCellKey(worksheet.rowOrder[2], worksheet.columnOrder[0])])
      .toBeUndefined();
  });

  it('maps calendar items to inert cell values', () => {
    const snapshot = calendarItemSnapshot([{
      id: 'event-1',
      uid: 'event-1',
      calendarId: 'calendar-1',
      title: 'Planning',
      kind: 'event',
      start: { kind: 'dateTime', dateTime: '2026-01-02T09:00:00Z', timeZone: 'UTC' },
      end: { kind: 'dateTime', dateTime: '2026-01-02T10:00:00Z', timeZone: 'UTC' },
      availability: 'busy',
      reminders: [],
      attendees: [],
      attachments: [],
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }], 'calendar-1');
    expect(snapshot.rows[0]).toMatchObject({
      title: 'Planning',
      kind: 'event',
      start: '2026-01-02T09:00:00Z',
    });
  });
});
