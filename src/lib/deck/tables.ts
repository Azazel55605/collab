/**
 * Editing a deck table: rows, columns, cells, and size.
 *
 * Pure functions from one `DeckTableElement` to the next; the view wraps them
 * in `updateElements`, so they share the deck's undo stack. The element's
 * frame and its row heights and column widths always agree: resizing the
 * frame scales them, and changing them resizes the frame.
 */
import { DECK_LIMITS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckFill, DeckRichText, DeckTableCell, DeckTableElement } from '../../types/deck';

import { tableCell } from './insert';
import type { ResolvedTableItem } from './resolve';
import { layoutText } from './textLayout';
import type { DeckTextMeasurer } from './textLayout';

/** The smallest a row or column may become. */
export const MIN_TABLE_TRACK = 6 * DECK_UNITS_PER_POINT;

export const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Scales `sizes` to total exactly `total`, keeping their proportions and integers. */
function scaleTracks(
  ids: string[],
  sizes: Record<string, number>,
  total: number,
): Record<string, number> {
  const current = ids.map((id) => Math.max(1, sizes[id] ?? 1));
  const whole = sum(current);
  const out: Record<string, number> = {};
  let used = 0;
  ids.forEach((id, index) => {
    const size =
      index === ids.length - 1
        ? Math.max(1, Math.round(total) - used)
        : Math.max(1, Math.round((current[index] / whole) * total));
    out[id] = size;
    used += size;
  });
  return out;
}

/** The table's frame size from its tracks. */
export function tableSize(table: DeckTableElement): { width: number; height: number } {
  return {
    width: sum(table.columnOrder.map((id) => table.columnWidths[id] ?? 0)),
    height: sum(table.rowOrder.map((id) => table.rowHeights[id] ?? 0)),
  };
}

function withFrameFromTracks(table: DeckTableElement): DeckTableElement {
  if (!table.frame) return table;
  const { width, height } = tableSize(table);
  return { ...table, frame: { ...table.frame, width, height } };
}

/** Rescales rows and columns to a new frame size, as a frame resize does. */
export function scaleTable(
  table: DeckTableElement,
  width: number,
  height: number,
): DeckTableElement {
  return {
    ...table,
    columnWidths: scaleTracks(table.columnOrder, table.columnWidths, width),
    rowHeights: scaleTracks(table.rowOrder, table.rowHeights, height),
  };
}

/** The cells of one row or column, copied as a style template for a new one. */
function styledLike(
  table: DeckTableElement,
  key: string | undefined,
  nextId: (prefix: string) => string,
): DeckTableCell {
  const source = key ? table.cells[key] : undefined;
  const fresh = tableCell(nextId('p'), false);
  if (!source) return fresh;
  const paragraph = source.text.content.paragraphs[0];
  return {
    text: {
      ...source.text,
      content: {
        paragraphs: [
          {
            id: fresh.text.content.paragraphs[0].id,
            runs: [],
            ...(paragraph?.style ? { style: paragraph.style } : {}),
            ...(paragraph?.endStyle ? { endStyle: paragraph.endStyle } : {}),
          },
        ],
      },
    },
    ...(source.fill ? { fill: source.fill } : {}),
  };
}

function checkCells(table: DeckTableElement): DeckTableElement {
  if (table.rowOrder.length > DECK_LIMITS.tableRows) {
    throw new Error(`A table can have at most ${DECK_LIMITS.tableRows} rows.`);
  }
  if (table.columnOrder.length > DECK_LIMITS.tableColumns) {
    throw new Error(`A table can have at most ${DECK_LIMITS.tableColumns} columns.`);
  }
  if (table.rowOrder.length * table.columnOrder.length > DECK_LIMITS.tableCells) {
    throw new Error(
      `A table can have at most ${DECK_LIMITS.tableCells.toLocaleString('en-US')} cells.`,
    );
  }
  return table;
}

/**
 * Inserts rows at `index`. New rows copy the size and cell styling of the
 * row they are inserted next to — the one below a header, never the header.
 */
export function insertTableRows(
  table: DeckTableElement,
  index: number,
  count: number,
  nextId: (prefix: string) => string,
): DeckTableElement {
  const at = Math.max(0, Math.min(table.rowOrder.length, index));
  const header = table.headerRow ? table.rowOrder[0] : undefined;
  const neighbours = [table.rowOrder[at - 1], table.rowOrder[at]].filter(
    (id): id is string => id !== undefined && id !== header,
  );
  const template = neighbours[0];
  const height =
    (template ? table.rowHeights[template] : undefined) ??
    table.rowHeights[table.rowOrder[0]] ??
    36 * DECK_UNITS_PER_POINT;
  const rows = Array.from({ length: Math.max(1, count) }, () => nextId('row'));
  const cells = { ...table.cells };
  for (const rowId of rows) {
    for (const columnId of table.columnOrder) {
      cells[cellKey(rowId, columnId)] = styledLike(
        table,
        template ? cellKey(template, columnId) : undefined,
        nextId,
      );
    }
  }
  const rowOrder = [...table.rowOrder];
  rowOrder.splice(at, 0, ...rows);
  return withFrameFromTracks(
    checkCells({
      ...table,
      rowOrder,
      rowHeights: { ...table.rowHeights, ...Object.fromEntries(rows.map((id) => [id, height])) },
      cells: extendSpans(table, cells, 'row', at, rows.length),
    }),
  );
}

/** Inserts columns at `index`, copying the neighbouring column's width and styling. */
export function insertTableColumns(
  table: DeckTableElement,
  index: number,
  count: number,
  nextId: (prefix: string) => string,
): DeckTableElement {
  const at = Math.max(0, Math.min(table.columnOrder.length, index));
  const template = table.columnOrder[at - 1] ?? table.columnOrder[at];
  const width = (template ? table.columnWidths[template] : undefined) ?? 120 * DECK_UNITS_PER_POINT;
  const columns = Array.from({ length: Math.max(1, count) }, () => nextId('col'));
  const cells = { ...table.cells };
  for (const columnId of columns) {
    for (const rowId of table.rowOrder) {
      cells[cellKey(rowId, columnId)] = styledLike(
        table,
        template ? cellKey(rowId, template) : undefined,
        nextId,
      );
    }
  }
  const columnOrder = [...table.columnOrder];
  columnOrder.splice(at, 0, ...columns);
  return withFrameFromTracks(
    checkCells({
      ...table,
      columnOrder,
      columnWidths: {
        ...table.columnWidths,
        ...Object.fromEntries(columns.map((id) => [id, width])),
      },
      cells: extendSpans(table, cells, 'column', at, columns.length),
    }),
  );
}

/** A merged cell spanning an insertion point grows over the new tracks. */
function extendSpans(
  table: DeckTableElement,
  cells: Record<string, DeckTableCell>,
  axis: 'row' | 'column',
  at: number,
  count: number,
): Record<string, DeckTableCell> {
  const out = { ...cells };
  table.rowOrder.forEach((rowId, row) => {
    table.columnOrder.forEach((columnId, column) => {
      const key = cellKey(rowId, columnId);
      const cell = table.cells[key];
      if (!cell) return;
      const start = axis === 'row' ? row : column;
      const span = (axis === 'row' ? cell.rowSpan : cell.colSpan) ?? 1;
      if (span > 1 && start < at && start + span > at) {
        out[key] =
          axis === 'row' ? { ...cell, rowSpan: span + count } : { ...cell, colSpan: span + count };
      }
    });
  });
  return out;
}

/**
 * Deletes rows. The last row cannot be deleted — deleting the table is the
 * way to remove it all. Merged cells shrink; a merge whose anchor row goes
 * is dissolved.
 */
export function deleteTableRows(table: DeckTableElement, rowIds: string[]): DeckTableElement {
  const doomed = new Set(rowIds.filter((id) => table.rowOrder.includes(id)));
  if (doomed.size === 0) return table;
  if (doomed.size >= table.rowOrder.length) throw new Error('A table needs at least one row.');
  const cells: Record<string, DeckTableCell> = {};
  table.rowOrder.forEach((rowId, row) => {
    if (doomed.has(rowId)) return;
    for (const columnId of table.columnOrder) {
      const key = cellKey(rowId, columnId);
      const cell = table.cells[key];
      if (!cell) continue;
      const span = cell.rowSpan ?? 1;
      if (span > 1) {
        const covered = table.rowOrder.slice(row, row + span);
        const kept = covered.filter((id) => !doomed.has(id)).length;
        cells[key] = kept > 1 ? { ...cell, rowSpan: kept } : withoutSpan(cell, 'rowSpan');
      } else {
        cells[key] = cell;
      }
    }
  });
  const rowOrder = table.rowOrder.filter((id) => !doomed.has(id));
  const rowHeights = Object.fromEntries(rowOrder.map((id) => [id, table.rowHeights[id]]));
  return withFrameFromTracks({
    ...table,
    rowOrder,
    rowHeights,
    cells,
    ...(table.headerRow && doomed.has(table.rowOrder[0]) ? { headerRow: false } : {}),
  });
}

/** Deletes columns; the last column cannot be deleted. */
export function deleteTableColumns(table: DeckTableElement, columnIds: string[]): DeckTableElement {
  const doomed = new Set(columnIds.filter((id) => table.columnOrder.includes(id)));
  if (doomed.size === 0) return table;
  if (doomed.size >= table.columnOrder.length) {
    throw new Error('A table needs at least one column.');
  }
  const cells: Record<string, DeckTableCell> = {};
  for (const rowId of table.rowOrder) {
    table.columnOrder.forEach((columnId, column) => {
      if (doomed.has(columnId)) return;
      const key = cellKey(rowId, columnId);
      const cell = table.cells[key];
      if (!cell) return;
      const span = cell.colSpan ?? 1;
      if (span > 1) {
        const covered = table.columnOrder.slice(column, column + span);
        const kept = covered.filter((id) => !doomed.has(id)).length;
        cells[key] = kept > 1 ? { ...cell, colSpan: kept } : withoutSpan(cell, 'colSpan');
      } else {
        cells[key] = cell;
      }
    });
  }
  const columnOrder = table.columnOrder.filter((id) => !doomed.has(id));
  const columnWidths = Object.fromEntries(columnOrder.map((id) => [id, table.columnWidths[id]]));
  return withFrameFromTracks({ ...table, columnOrder, columnWidths, cells });
}

function withoutSpan(cell: DeckTableCell, key: 'rowSpan' | 'colSpan'): DeckTableCell {
  const next = { ...cell };
  delete next[key];
  return next;
}

/** Replaces one cell's text, creating the cell if it was empty. */
export function setCellContent(
  table: DeckTableElement,
  key: string,
  content: DeckRichText,
): DeckTableElement {
  const current = table.cells[key] ?? tableCell(`${key}-p`, false);
  return {
    ...table,
    cells: { ...table.cells, [key]: { ...current, text: { ...current.text, content } } },
  };
}

/** Sets (or, with `null`, clears) the fill of cells. */
export function setCellFill(
  table: DeckTableElement,
  keys: string[],
  fill: DeckFill | null,
): DeckTableElement {
  const cells = { ...table.cells };
  for (const key of keys) {
    const current = cells[key] ?? tableCell(`${key}-p`, false);
    const next = { ...current };
    if (fill) next.fill = fill;
    else delete next.fill;
    cells[key] = next;
  }
  return { ...table, cells };
}

/** Turns the header flag on or off; styling stays explicit cell content. */
export function setHeaderRow(table: DeckTableElement, on: boolean): DeckTableElement {
  const next = { ...table };
  if (on) next.headerRow = true;
  else delete next.headerRow;
  return next;
}

/** The anchor cell (the top-left of a merge) under a point, in slide units. */
export function cellAtPoint(
  item: ResolvedTableItem,
  point: { x: number; y: number },
): { rowId: string; columnId: string } | null {
  // Tables may be rotated: bring the point into the table's own axes.
  const { frame } = item;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const angle = -((frame.rotation ?? 0) / 18_000) * Math.PI;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const local = {
    x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: cy + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
  const cell = item.cells.find(
    (entry) =>
      local.x >= entry.x &&
      local.x <= entry.x + entry.width &&
      local.y >= entry.y &&
      local.y <= entry.y + entry.height,
  );
  return cell ? { rowId: cell.rowId, columnId: cell.columnId } : null;
}

/**
 * Grows rows whose text no longer fits, as PowerPoint does as you type.
 * Rows never shrink here; a person resizes them down deliberately.
 */
export function fitTableRows(
  table: DeckTableElement,
  item: ResolvedTableItem,
  measurer: DeckTextMeasurer,
): DeckTableElement {
  const needed = new Map<string, number>();
  for (const cell of item.cells) {
    if (cell.rowSpan > 1) continue;
    const layout = layoutText(cell.text, cell.width, cell.height, measurer);
    const height = Math.ceil(layout.contentHeight);
    needed.set(cell.rowId, Math.max(needed.get(cell.rowId) ?? 0, height));
  }
  let changed = false;
  const rowHeights = { ...table.rowHeights };
  for (const rowId of table.rowOrder) {
    const want = Math.max(MIN_TABLE_TRACK, needed.get(rowId) ?? 0);
    if (want > (rowHeights[rowId] ?? 0) + 1) {
      rowHeights[rowId] = want;
      changed = true;
    }
  }
  return changed ? withFrameFromTracks({ ...table, rowHeights }) : table;
}
