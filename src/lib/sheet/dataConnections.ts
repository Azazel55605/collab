import type { CalendarItem } from '../../types/calendar';
import type { KanbanBoard } from '../../types/kanban';
import {
  SHEET_LIMITS,
  sheetCellKey,
  type SheetDataConnection,
  type SheetDataConnectionKind,
  type SheetDocument,
  type SheetWorksheet,
} from '../../types/sheet';
import type { SheetPosition } from './address';
import { createSheetDataConnectionId } from './document';
import { insertTracks, worksheetById } from './operations';

interface SnapshotColumn {
  key: string;
  label: string;
}

const KANBAN_COLUMNS: SnapshotColumn[] = [
  { key: 'title', label: 'Task' },
  { key: 'column', label: 'Column' },
  { key: 'dueDate', label: 'Due' },
  { key: 'priority', label: 'Priority' },
  { key: 'assignees', label: 'Assignees' },
  { key: 'done', label: 'Done' },
];

const CALENDAR_COLUMNS: SnapshotColumn[] = [
  { key: 'title', label: 'Title' },
  { key: 'kind', label: 'Type' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End / due' },
  { key: 'status', label: 'Status' },
];

export interface SheetSnapshotInput {
  kind: SheetDataConnectionKind;
  sourcePath?: string;
  calendarId?: string;
  rows: Array<Record<string, string | number | boolean | null>>;
}

function kanbanBoard(value: unknown): KanbanBoard {
  if (!value || typeof value !== 'object' || !Array.isArray((value as KanbanBoard).columns)) {
    throw new Error('The selected file is not a valid Kanban board.');
  }
  return value as KanbanBoard;
}

export function kanbanTaskSnapshot(content: string, sourcePath: string): SheetSnapshotInput {
  const board = kanbanBoard(JSON.parse(content));
  return {
    kind: 'kanbanTasks',
    sourcePath,
    rows: board.columns.flatMap((column) => column.cards
      .filter((card) => !card.archived)
      .map((card) => ({
        title: card.title,
        column: column.title,
        dueDate: card.dueDate ?? '',
        priority: card.priority ?? '',
        assignees: card.assignees.join(', '),
        done: Boolean(card.isDone),
      }))),
  };
}

function calendarTimeLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.date === 'string') return record.date;
  if (typeof record.dateTime === 'string') return record.dateTime;
  return '';
}

export function calendarItemSnapshot(
  items: CalendarItem[],
  calendarId: string,
): SheetSnapshotInput {
  return {
    kind: 'calendarItems',
    calendarId,
    rows: items.filter((item) => !item.deletedAt).map((item) => ({
      title: item.title,
      kind: item.kind,
      start: item.kind === 'birthday'
        ? item.date
        : calendarTimeLabel(item.start),
      end: item.kind === 'event'
        ? calendarTimeLabel(item.end)
        : item.kind === 'task'
          ? calendarTimeLabel(item.due)
          : '',
      status: item.kind === 'task' ? item.status : '',
    })),
  };
}

function columnsFor(kind: SheetDataConnectionKind) {
  return kind === 'kanbanTasks' ? KANBAN_COLUMNS : CALENDAR_COLUMNS;
}

function ensureSnapshotCapacity(
  document: SheetDocument,
  worksheetId: string,
  start: SheetPosition,
  rowCount: number,
  columnCount: number,
) {
  let next = document;
  let worksheet = worksheetById(next, worksheetId);
  if (!worksheet) throw new Error('The target worksheet no longer exists.');
  const neededRows = start.row + rowCount;
  const neededColumns = start.column + columnCount;
  if (neededRows > SHEET_LIMITS.rowsPerWorksheet || neededColumns > SHEET_LIMITS.columnsPerWorksheet) {
    throw new Error('The snapshot exceeds the worksheet limits.');
  }
  if (neededRows > worksheet.rowOrder.length) {
    next = insertTracks(
      next,
      worksheetId,
      'row',
      worksheet.rowOrder.length,
      neededRows - worksheet.rowOrder.length,
    );
  }
  worksheet = worksheetById(next, worksheetId)!;
  if (neededColumns > worksheet.columnOrder.length) {
    next = insertTracks(
      next,
      worksheetId,
      'column',
      worksheet.columnOrder.length,
      neededColumns - worksheet.columnOrder.length,
    );
  }
  return next;
}

function connectionStart(worksheet: SheetWorksheet, connection: SheetDataConnection): SheetPosition | null {
  const row = worksheet.rowOrder.indexOf(connection.targetRange.startRowId);
  const column = worksheet.columnOrder.indexOf(connection.targetRange.startColumnId);
  return row >= 0 && column >= 0 ? { row, column } : null;
}

export function applySheetDataSnapshot(
  document: SheetDocument,
  worksheetId: string,
  start: SheetPosition,
  snapshot: SheetSnapshotInput,
  existingConnectionId?: string,
): SheetDocument {
  const columns = columnsFor(snapshot.kind);
  const boundedRows = snapshot.rows.slice(0, 5_000);
  let next = ensureSnapshotCapacity(
    document,
    worksheetId,
    start,
    boundedRows.length + 1,
    columns.length,
  );
  const worksheet = worksheetById(next, worksheetId)!;
  const existing = existingConnectionId
    ? next.dataConnections?.find((connection) => connection.id === existingConnectionId)
    : undefined;
  const oldRowCount = existing?.itemCount ?? 0;
  const cells = { ...worksheet.cells };
  const clearRows = Math.max(oldRowCount, boundedRows.length) + 1;
  for (let rowOffset = 0; rowOffset < clearRows; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < columns.length; columnOffset += 1) {
      const rowId = worksheet.rowOrder[start.row + rowOffset];
      const columnId = worksheet.columnOrder[start.column + columnOffset];
      if (rowId && columnId) delete cells[sheetCellKey(rowId, columnId)];
    }
  }
  columns.forEach((column, columnOffset) => {
    cells[sheetCellKey(
      worksheet.rowOrder[start.row],
      worksheet.columnOrder[start.column + columnOffset],
    )] = { value: column.label, valueType: 'text' };
  });
  boundedRows.forEach((row, rowOffset) => {
    columns.forEach((column, columnOffset) => {
      const value = row[column.key] ?? '';
      cells[sheetCellKey(
        worksheet.rowOrder[start.row + rowOffset + 1],
        worksheet.columnOrder[start.column + columnOffset],
      )] = {
        value,
        valueType: typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean' ? 'boolean' : 'text',
      };
    });
  });
  const endRow = start.row + boundedRows.length;
  const connection: SheetDataConnection = {
    id: existing?.id ?? createSheetDataConnectionId(),
    kind: snapshot.kind,
    ...(snapshot.sourcePath ? { sourcePath: snapshot.sourcePath } : {}),
    ...(snapshot.calendarId ? { calendarId: snapshot.calendarId } : {}),
    targetWorksheetId: worksheetId,
    targetRange: {
      startRowId: worksheet.rowOrder[start.row],
      startColumnId: worksheet.columnOrder[start.column],
      endRowId: worksheet.rowOrder[endRow],
      endColumnId: worksheet.columnOrder[start.column + columns.length - 1],
    },
    columns: columns.map((column, offset) => ({
      ...column,
      columnId: worksheet.columnOrder[start.column + offset],
    })),
    refreshedAt: new Date().toISOString(),
    itemCount: boundedRows.length,
  };
  const dataConnections = [
    ...(next.dataConnections ?? []).filter((candidate) => candidate.id !== connection.id),
    connection,
  ];
  return {
    ...next,
    worksheets: next.worksheets.map((candidate) => (
      candidate.id === worksheetId ? { ...candidate, cells } : candidate
    )),
    dataConnections,
  };
}

export function refreshSheetDataSnapshot(
  document: SheetDocument,
  connectionId: string,
  snapshot: SheetSnapshotInput,
) {
  const connection = document.dataConnections?.find((candidate) => candidate.id === connectionId);
  if (!connection) throw new Error('The data connection no longer exists.');
  const worksheet = worksheetById(document, connection.targetWorksheetId);
  const start = worksheet ? connectionStart(worksheet, connection) : null;
  if (!worksheet || !start) throw new Error('The data connection target no longer exists.');
  return applySheetDataSnapshot(
    document,
    worksheet.id,
    start,
    snapshot,
    connection.id,
  );
}

export function removeSheetDataConnection(document: SheetDocument, connectionId: string) {
  const dataConnections = document.dataConnections?.filter(
    (connection) => connection.id !== connectionId,
  );
  if (dataConnections?.length === document.dataConnections?.length) return document;
  const next = { ...document };
  if (dataConnections && dataConnections.length > 0) next.dataConnections = dataConnections;
  else delete next.dataConnections;
  return next;
}
