/**
 * Structural and cell operations on a `.sheet` workbook.
 *
 * Every function is pure: it takes a document and returns a new one, never
 * mutating the input. That keeps the session controller's dirty tracking honest
 * and makes each operation testable without a renderer.
 *
 * Structural operations rewrite formula references from the stable row/column
 * identities before and after the mutation.
 */

import { SHEET_LIMITS, sheetCellKey } from '../../types/sheet';
import type {
  SheetCell,
  SheetColumn,
  SheetConditionalFormat,
  SheetDocument,
  SheetFilterState,
  SheetRange,
  SheetRow,
  SheetTable,
  SheetValidation,
  SheetWorksheet,
} from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import {
  SheetDocumentError,
  createSheetColumnId,
  createSheetConditionalFormatId,
  createSheetNamedRangeId,
  createSheetProtectedRangeId,
  createSheetRowId,
  createSheetTableColumnId,
  createSheetTableId,
  createSheetValidationId,
  createSheetWorksheetId,
} from './document';
import type { SheetPosition } from './address';
import { normalizeRange, selectedPositions, type SheetSelection } from './selection';
import { numericValueOf } from './cellValue';
import { rewriteDocumentFormulaReferences } from './formulaReferences';

function mapWorksheet(
  document: SheetDocument,
  worksheetId: string,
  update: (worksheet: SheetWorksheet) => SheetWorksheet,
): SheetDocument {
  let changed = false;
  const worksheets = document.worksheets.map((worksheet) => {
    if (worksheet.id !== worksheetId) return worksheet;
    const next = update(worksheet);
    changed = next !== worksheet;
    return next;
  });
  return changed ? { ...document, worksheets } : document;
}

export function worksheetById(
  document: SheetDocument,
  worksheetId: string | undefined,
): SheetWorksheet | null {
  if (!worksheetId) return null;
  return document.worksheets.find((worksheet) => worksheet.id === worksheetId) ?? null;
}

export function activeWorksheet(document: SheetDocument): SheetWorksheet {
  return worksheetById(document, document.activeWorksheetId) ?? document.worksheets[0];
}

export function setActiveWorksheet(document: SheetDocument, worksheetId: string): SheetDocument {
  if (!document.worksheets.some((worksheet) => worksheet.id === worksheetId)) return document;
  if (document.activeWorksheetId === worksheetId) return document;
  return { ...document, activeWorksheetId: worksheetId };
}

// ── Cells ────────────────────────────────────────────────────────────────────

/**
 * Writes or clears one cell. Passing `null` removes it from the sparse map,
 * which is what keeps an emptied cell from bloating the document.
 */
export function setCell(
  document: SheetDocument,
  worksheetId: string,
  position: SheetPosition,
  cell: SheetCell | null,
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) return worksheet;

    const key = sheetCellKey(rowId, columnId);
    const existing = worksheet.cells[key];
    if (!cell && !existing) return worksheet;

    const cells = { ...worksheet.cells };
    if (cell) {
      // Preserve per-cell presentation the caller did not touch.
      const preserved: SheetCell = {};
      if (existing?.styleId && !cell.styleId) preserved.styleId = existing.styleId;
      if (existing?.note && cell.note === undefined) preserved.note = existing.note;
      if (existing?.validationId && cell.validationId === undefined) {
        preserved.validationId = existing.validationId;
      }
      cells[key] = { ...cell, ...preserved };
      if (Object.keys(cells).length > SHEET_LIMITS.populatedCellsPerWorksheet) {
        throw new SheetDocumentError(
          'limit-exceeded',
          `A worksheet may not have more than ${SHEET_LIMITS.populatedCellsPerWorksheet} populated cells.`,
        );
      }
    } else if (existing) {
      const preserved: SheetCell = {};
      if (existing.styleId) preserved.styleId = existing.styleId;
      if (existing.note) preserved.note = existing.note;
      if (existing.validationId) preserved.validationId = existing.validationId;
      if (Object.keys(preserved).length > 0) cells[key] = preserved;
      else delete cells[key];
    }
    return { ...worksheet, cells };
  });
}

/** Updates only cell note metadata, leaving value, formula, style, and validation intact. */
export function setCellNote(
  document: SheetDocument,
  worksheetId: string,
  position: SheetPosition,
  note: string | null,
): SheetDocument {
  if (note && note.length > SHEET_LIMITS.cellTextLength) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Cell notes may not exceed ${SHEET_LIMITS.cellTextLength.toLocaleString()} characters.`,
    );
  }
  return mapWorksheet(document, worksheetId, (worksheet) => {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) return worksheet;
    const key = sheetCellKey(rowId, columnId);
    const existing = worksheet.cells[key];
    if (!existing && !note) return worksheet;
    const nextCell: SheetCell = { ...(existing ?? {}) };
    if (note) nextCell.note = note;
    else delete nextCell.note;
    const cells = { ...worksheet.cells };
    if (Object.keys(nextCell).length > 0) cells[key] = nextCell;
    else delete cells[key];
    return { ...worksheet, cells };
  });
}

export function getCell(
  worksheet: SheetWorksheet,
  position: SheetPosition,
): SheetCell | undefined {
  const rowId = worksheet.rowOrder[position.row];
  const columnId = worksheet.columnOrder[position.column];
  if (!rowId || !columnId) return undefined;
  return worksheet.cells[sheetCellKey(rowId, columnId)];
}

/** Clears every cell in the selection, keeping row/column structure intact. */
export function clearCells(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => {
    const cells = { ...worksheet.cells };
    let removed = 0;
    for (const position of selectedPositions(selection)) {
      const rowId = worksheet.rowOrder[position.row];
      const columnId = worksheet.columnOrder[position.column];
      if (!rowId || !columnId) continue;
      const key = sheetCellKey(rowId, columnId);
      const existing = cells[key];
      if (!existing) continue;
      const preserved: SheetCell = {};
      if (existing.styleId) preserved.styleId = existing.styleId;
      if (existing.note) preserved.note = existing.note;
      if (existing.validationId) preserved.validationId = existing.validationId;
      if (Object.keys(preserved).length > 0) cells[key] = preserved;
      else delete cells[key];
      removed += 1;
    }
    return removed > 0 ? { ...worksheet, cells } : worksheet;
  });
}

// ── Rows and columns ─────────────────────────────────────────────────────────

type Axis = 'row' | 'column';

function axisOrder(worksheet: SheetWorksheet, axis: Axis): string[] {
  return axis === 'row' ? worksheet.rowOrder : worksheet.columnOrder;
}

function withAxisOrder(worksheet: SheetWorksheet, axis: Axis, order: string[]): SheetWorksheet {
  return axis === 'row'
    ? { ...worksheet, rowOrder: order }
    : { ...worksheet, columnOrder: order };
}

function axisLimit(axis: Axis): number {
  return axis === 'row' ? SHEET_LIMITS.rowsPerWorksheet : SHEET_LIMITS.columnsPerWorksheet;
}

function createAxisId(axis: Axis): string {
  return axis === 'row' ? createSheetRowId() : createSheetColumnId();
}

function shrinkRange(
  worksheet: SheetWorksheet,
  range: SheetRange,
  removed: Set<string>,
  axis: Axis,
): SheetRange | null {
  const order = axisOrder(worksheet, axis);
  const startId = axis === 'row' ? range.startRowId : range.startColumnId;
  const endId = axis === 'row' ? range.endRowId : range.endColumnId;
  const start = order.indexOf(startId);
  const end = order.indexOf(endId);
  if (start < 0 || end < 0) return null;

  const surviving = order
    .slice(Math.min(start, end), Math.max(start, end) + 1)
    .filter((id) => !removed.has(id));
  if (surviving.length === 0) return null;

  return axis === 'row'
    ? { ...range, startRowId: surviving[0], endRowId: surviving[surviving.length - 1] }
    : {
      ...range,
      startColumnId: surviving[0],
      endColumnId: surviving[surviving.length - 1],
    };
}

function clearFilterHiddenRows(worksheet: SheetWorksheet): SheetWorksheet {
  if (!worksheet.rows) return worksheet;
  const rows: Record<string, SheetRow> = {};
  let changed = false;
  for (const [id, row] of Object.entries(worksheet.rows)) {
    if (!row.filterHidden) {
      rows[id] = row;
      continue;
    }
    changed = true;
    const { filterHidden: _filterHidden, ...visibleRow } = row;
    if (Object.keys(visibleRow).length > 1) rows[id] = visibleRow;
  }
  if (!changed) return worksheet;
  const next = { ...worksheet };
  if (Object.keys(rows).length > 0) next.rows = rows;
  else delete next.rows;
  return next;
}

/** Drops cells and track properties, then repairs structures referencing removed IDs. */
function pruneReferences(worksheet: SheetWorksheet, removed: Set<string>, axis: Axis): SheetWorksheet {
  if (removed.size === 0) return worksheet;

  const cells: Record<string, SheetCell> = {};
  for (const [key, cell] of Object.entries(worksheet.cells)) {
    const separator = key.indexOf(':');
    const rowId = key.slice(0, separator);
    const columnId = key.slice(separator + 1);
    if (removed.has(axis === 'row' ? rowId : columnId)) continue;
    cells[key] = cell;
  }

  const next: SheetWorksheet = { ...worksheet, cells };

  const trackKey = axis === 'row' ? 'rows' : 'columns';
  const tracks = worksheet[trackKey];
  if (tracks) {
    const kept = Object.fromEntries(
      Object.entries(tracks).filter(([id]) => !removed.has(id)),
    );
    const mutable = next as unknown as Record<string, unknown>;
    if (Object.keys(kept).length > 0) mutable[trackKey] = kept;
    else delete mutable[trackKey];
  }

  if (worksheet.mergedRanges) {
    const kept = worksheet.mergedRanges.filter((range) => (
      axis === 'row'
        ? !removed.has(range.startRowId) && !removed.has(range.endRowId)
        : !removed.has(range.startColumnId) && !removed.has(range.endColumnId)
    ));
    if (kept.length > 0) next.mergedRanges = kept;
    else delete next.mergedRanges;
  }

  if (worksheet.tables) {
    const tables = worksheet.tables.flatMap((table): SheetTable[] => {
      const range = shrinkRange(worksheet, table.range, removed, axis);
      if (!range) return [];
      const columns = axis === 'column'
        ? table.columns.filter((column) => !removed.has(column.columnId))
        : table.columns;
      if (columns.length === 0) return [];
      return [{ ...table, range, columns }];
    });
    if (tables.length > 0) next.tables = tables;
    else delete next.tables;
  }

  if (worksheet.filters?.range) {
    const range = shrinkRange(worksheet, worksheet.filters.range, removed, axis);
    const removedFilteredColumn = axis === 'column'
      && (worksheet.filters.columnFilters ?? []).some((filter) => removed.has(filter.columnId));
    if (!range || removedFilteredColumn) {
      delete next.filters;
      return clearFilterHiddenRows(next);
    }
    const filters: SheetFilterState = {
      ...worksheet.filters,
      range,
      sortRules: worksheet.filters.sortRules?.filter((rule) => !removed.has(rule.columnId)),
      columnFilters: worksheet.filters.columnFilters?.filter(
        (filter) => !removed.has(filter.columnId),
      ),
    };
    if (filters.sortRules?.length === 0) delete filters.sortRules;
    if (filters.columnFilters?.length === 0) delete filters.columnFilters;
    next.filters = filters;
  }

  if (worksheet.validations) {
    const dropped = new Set<string>();
    const validations = worksheet.validations.flatMap((validation): SheetValidation[] => {
      if (!validation.sourceRange) return [validation];
      const sourceRange = shrinkRange(worksheet, validation.sourceRange, removed, axis);
      if (!sourceRange) {
        dropped.add(validation.id);
        return [];
      }
      return [{ ...validation, sourceRange }];
    });
    if (dropped.size > 0) {
      for (const [key, cell] of Object.entries(next.cells)) {
        if (!cell.validationId || !dropped.has(cell.validationId)) continue;
        const repaired = { ...cell };
        delete repaired.validationId;
        if (Object.keys(repaired).length > 0) next.cells[key] = repaired;
        else delete next.cells[key];
      }
    }
    if (validations.length > 0) next.validations = validations;
    else delete next.validations;
  }

  if (worksheet.conditionalFormats) {
    const conditionalFormats = worksheet.conditionalFormats.flatMap(
      (format): SheetConditionalFormat[] => {
        const ranges = format.ranges.flatMap((range) => {
          const repaired = shrinkRange(worksheet, range, removed, axis);
          return repaired ? [repaired] : [];
        });
        return ranges.length > 0 ? [{ ...format, ranges }] : [];
      },
    );
    if (conditionalFormats.length > 0) next.conditionalFormats = conditionalFormats;
    else delete next.conditionalFormats;
  }

  if (worksheet.protectedRanges) {
    const protectedRanges = worksheet.protectedRanges.flatMap((protectedRange) => {
      const range = shrinkRange(worksheet, protectedRange.range, removed, axis);
      return range ? [{ ...protectedRange, range }] : [];
    });
    if (protectedRanges.length > 0) next.protectedRanges = protectedRanges;
    else delete next.protectedRanges;
  }

  return next;
}

export function insertTracks(
  document: SheetDocument,
  worksheetId: string,
  axis: Axis,
  atIndex: number,
  count = 1,
): SheetDocument {
  if (count <= 0) return document;
  const next = mapWorksheet(document, worksheetId, (worksheet) => {
    const order = axisOrder(worksheet, axis);
    if (order.length + count > axisLimit(axis)) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${axisLimit(axis)} ${axis}s.`,
      );
    }
    const index = Math.max(0, Math.min(atIndex, order.length));
    const inserted = Array.from({ length: count }, () => createAxisId(axis));
    return withAxisOrder(worksheet, axis, [
      ...order.slice(0, index),
      ...inserted,
      ...order.slice(index),
    ]);
  });
  return rewriteDocumentFormulaReferences(document, next);
}

export function deleteTracks(
  document: SheetDocument,
  worksheetId: string,
  axis: Axis,
  fromIndex: number,
  count = 1,
): SheetDocument {
  if (count <= 0) return document;
  const source = worksheetById(document, worksheetId);
  if (!source) return document;
  const sourceOrder = axisOrder(source, axis);
  const sourceIndex = Math.max(0, Math.min(fromIndex, sourceOrder.length - 1));
  const removed = new Set(sourceOrder.slice(sourceIndex, sourceIndex + count));
  const next = mapWorksheet(document, worksheetId, (worksheet) => {
    const order = axisOrder(worksheet, axis);
    const index = Math.max(0, Math.min(fromIndex, order.length - 1));
    const removedIds = order.slice(index, index + count);
    if (removedIds.length === 0) return worksheet;
    if (removedIds.length >= order.length) {
      throw new SheetDocumentError(
        'invalid-structure',
        `A worksheet must keep at least one ${axis}.`,
      );
    }
    const remaining = [...order.slice(0, index), ...order.slice(index + removedIds.length)];
    const pruned = pruneReferences(worksheet, new Set(removedIds), axis);
    return withAxisOrder(pruned, axis, remaining);
  });
  const namedRanges = (document.namedRanges ?? []).flatMap((namedRange) => {
    if (namedRange.worksheetId !== worksheetId) return [namedRange];
    const range = shrinkRange(source, namedRange.range, removed, axis);
    return range ? [{ ...namedRange, range }] : [];
  });
  const repaired = namedRanges.length > 0
    ? { ...next, namedRanges }
    : Object.fromEntries(
      Object.entries(next).filter(([key]) => key !== 'namedRanges'),
    ) as SheetDocument;
  return rewriteDocumentFormulaReferences(document, repaired);
}

/** Moves a contiguous block of rows/columns so it starts at `toIndex`. */
export function moveTracks(
  document: SheetDocument,
  worksheetId: string,
  axis: Axis,
  fromIndex: number,
  count: number,
  toIndex: number,
): SheetDocument {
  if (count <= 0) return document;
  const nextDocument = mapWorksheet(document, worksheetId, (worksheet) => {
    const order = axisOrder(worksheet, axis);
    const moving = order.slice(fromIndex, fromIndex + count);
    if (moving.length === 0) return worksheet;
    const remaining = [...order.slice(0, fromIndex), ...order.slice(fromIndex + moving.length)];
    const target = Math.max(0, Math.min(toIndex, remaining.length));
    const next = [...remaining.slice(0, target), ...moving, ...remaining.slice(target)];
    if (next.every((id, index) => id === order[index])) return worksheet;
    return withAxisOrder(worksheet, axis, next);
  });
  return rewriteDocumentFormulaReferences(document, nextDocument);
}

function updateTrack(
  worksheet: SheetWorksheet,
  axis: Axis,
  id: string,
  update: (track: SheetRow | SheetColumn) => SheetRow | SheetColumn,
): SheetWorksheet {
  const trackKey = axis === 'row' ? 'rows' : 'columns';
  const tracks = { ...(worksheet[trackKey] ?? {}) } as Record<string, SheetRow | SheetColumn>;
  tracks[id] = update(tracks[id] ?? { id });
  return { ...worksheet, [trackKey]: tracks } as SheetWorksheet;
}

export function resizeTrack(
  document: SheetDocument,
  worksheetId: string,
  axis: Axis,
  index: number,
  size: number,
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => {
    const id = axisOrder(worksheet, axis)[index];
    if (!id) return worksheet;
    const clamped = Math.max(axis === 'row' ? 8 : 24, Math.round(size));
    return updateTrack(worksheet, axis, id, (track) => (
      axis === 'row'
        ? { ...(track as SheetRow), height: clamped }
        : { ...(track as SheetColumn), width: clamped }
    ));
  });
}

export function setTrackHidden(
  document: SheetDocument,
  worksheetId: string,
  axis: Axis,
  indices: number[],
  hidden: boolean,
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => {
    let next = worksheet;
    for (const index of indices) {
      const id = axisOrder(worksheet, axis)[index];
      if (!id) continue;
      next = updateTrack(next, axis, id, (track) => {
        if (hidden) return { ...track, hidden: true };
        const { hidden: _removed, ...rest } = track;
        return rest as SheetRow | SheetColumn;
      });
    }
    return next;
  });
}

/**
 * Auto-sizes a column to its widest populated cell. Text measurement is
 * injected so this stays pure and testable — the grid passes a canvas-backed
 * measurer, tests pass a deterministic one.
 */
export function autoSizeColumn(
  document: SheetDocument,
  worksheetId: string,
  columnIndex: number,
  measure: (text: string) => number,
  options: { padding?: number; min?: number; max?: number } = {},
): SheetDocument {
  const worksheet = worksheetById(document, worksheetId);
  if (!worksheet) return document;
  const columnId = worksheet.columnOrder[columnIndex];
  if (!columnId) return document;

  const padding = options.padding ?? 16;
  const min = options.min ?? 48;
  const max = options.max ?? 480;

  let widest = 0;
  for (const rowId of worksheet.rowOrder) {
    const cell = worksheet.cells[sheetCellKey(rowId, columnId)];
    if (!cell) continue;
    const text = cell.formula ?? (cell.value === undefined || cell.value === null ? '' : String(cell.value));
    if (!text) continue;
    widest = Math.max(widest, measure(text));
  }

  const width = Math.max(min, Math.min(max, Math.ceil(widest + padding)));
  return resizeTrack(document, worksheetId, 'column', columnIndex, width);
}

// ── Merged ranges and frozen panes ───────────────────────────────────────────

function rangeFromSelection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
): SheetRange | null {
  if (selection.ranges.length !== 1) return null;
  const rectangle = normalizeRange(selection.ranges[0]);
  const startRowId = worksheet.rowOrder[rectangle.top];
  const endRowId = worksheet.rowOrder[rectangle.bottom];
  const startColumnId = worksheet.columnOrder[rectangle.left];
  const endColumnId = worksheet.columnOrder[rectangle.right];
  if (!startRowId || !endRowId || !startColumnId || !endColumnId) return null;
  return { startRowId, startColumnId, endRowId, endColumnId };
}

function rangeRectangle(worksheet: SheetWorksheet, range: SheetRange) {
  const top = worksheet.rowOrder.indexOf(range.startRowId);
  const bottom = worksheet.rowOrder.indexOf(range.endRowId);
  const left = worksheet.columnOrder.indexOf(range.startColumnId);
  const right = worksheet.columnOrder.indexOf(range.endColumnId);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  return {
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
  };
}

/** The merged range covering a position, if any. */
export function mergedRangeAt(
  worksheet: SheetWorksheet,
  position: SheetPosition,
): SheetRange | null {
  for (const range of worksheet.mergedRanges ?? []) {
    const rectangle = rangeRectangle(worksheet, range);
    if (!rectangle) continue;
    if (position.row >= rectangle.top && position.row <= rectangle.bottom
      && position.column >= rectangle.left && position.column <= rectangle.right) {
      return range;
    }
  }
  return null;
}

/**
 * Merges the selected rectangle. Only the top-left cell's content survives —
 * the same rule every spreadsheet uses — and overlapping merges are rejected
 * rather than silently nested.
 */
export function mergeSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  const worksheet = worksheetById(document, worksheetId);
  if (!worksheet) return document;
  const range = rangeFromSelection(worksheet, selection);
  if (!range) {
    throw new SheetDocumentError('invalid-structure', 'Select a single rectangular range to merge.');
  }
  const rectangle = rangeRectangle(worksheet, range)!;
  if (rectangle.top === rectangle.bottom && rectangle.left === rectangle.right) {
    throw new SheetDocumentError('invalid-structure', 'Select more than one cell to merge.');
  }

  for (const existing of worksheet.mergedRanges ?? []) {
    const other = rangeRectangle(worksheet, existing);
    if (!other) continue;
    const overlaps = rectangle.top <= other.bottom && rectangle.bottom >= other.top
      && rectangle.left <= other.right && rectangle.right >= other.left;
    if (overlaps) {
      throw new SheetDocumentError('invalid-structure', 'That range overlaps an existing merged range.');
    }
  }

  if ((worksheet.mergedRanges?.length ?? 0) >= SHEET_LIMITS.mergedRangesPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A worksheet may not have more than ${SHEET_LIMITS.mergedRangesPerWorksheet} merged ranges.`,
    );
  }

  return mapWorksheet(document, worksheetId, (sheet) => {
    const cells = { ...sheet.cells };
    for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
      for (let column = rectangle.left; column <= rectangle.right; column += 1) {
        if (row === rectangle.top && column === rectangle.left) continue;
        delete cells[sheetCellKey(sheet.rowOrder[row], sheet.columnOrder[column])];
      }
    }
    return { ...sheet, cells, mergedRanges: [...(sheet.mergedRanges ?? []), range] };
  });
}

/** Removes every merged range intersecting the selection. */
export function unmergeSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => {
    if (!worksheet.mergedRanges?.length) return worksheet;
    const positions = selectedPositions(selection);
    const kept = worksheet.mergedRanges.filter((range) => {
      const rectangle = rangeRectangle(worksheet, range);
      if (!rectangle) return false;
      return !positions.some((position) => (
        position.row >= rectangle.top && position.row <= rectangle.bottom
        && position.column >= rectangle.left && position.column <= rectangle.right
      ));
    });
    if (kept.length === worksheet.mergedRanges.length) return worksheet;
    const next = { ...worksheet };
    if (kept.length > 0) next.mergedRanges = kept;
    else delete next.mergedRanges;
    return next;
  });
}

export function setFrozen(
  document: SheetDocument,
  worksheetId: string,
  frozen: { rows: number; columns: number },
): SheetDocument {
  return mapWorksheet(document, worksheetId, (worksheet) => ({
    ...worksheet,
    frozen: {
      rows: Math.max(0, Math.min(frozen.rows, worksheet.rowOrder.length)),
      columns: Math.max(0, Math.min(frozen.columns, worksheet.columnOrder.length)),
    },
  }));
}

// ── Worksheets ───────────────────────────────────────────────────────────────

/** Copies a worksheet, giving every row, column, and the sheet itself new IDs. */
export function duplicateWorksheet(document: SheetDocument, worksheetId: string): SheetDocument {
  const source = worksheetById(document, worksheetId);
  if (!source) return document;
  if (document.worksheets.length >= SHEET_LIMITS.worksheetsPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.worksheetsPerWorkbook} worksheets.`,
    );
  }

  const rowMap = new Map(source.rowOrder.map((id) => [id, createSheetRowId()]));
  const columnMap = new Map(source.columnOrder.map((id) => [id, createSheetColumnId()]));

  const cells: Record<string, SheetCell> = {};
  for (const [key, cell] of Object.entries(source.cells)) {
    const separator = key.indexOf(':');
    const rowId = rowMap.get(key.slice(0, separator));
    const columnId = columnMap.get(key.slice(separator + 1));
    if (!rowId || !columnId) continue;
    cells[sheetCellKey(rowId, columnId)] = { ...cell };
  }
  const validationMap = new Map<string, string>();

  const remapTracks = <T extends SheetRow | SheetColumn>(
    tracks: Record<string, T> | undefined,
    map: Map<string, string>,
  ) => {
    if (!tracks) return undefined;
    const out: Record<string, T> = {};
    for (const [id, track] of Object.entries(tracks)) {
      const next = map.get(id);
      if (next) out[next] = { ...track, id: next };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const taken = new Set(document.worksheets.map((worksheet) => worksheet.name.toLowerCase()));
  let name = `${source.name} copy`;
  let suffix = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${source.name} copy ${suffix}`;
    suffix += 1;
  }

  const copy: SheetWorksheet = {
    ...source,
    id: createSheetWorksheetId(),
    name,
    rowOrder: source.rowOrder.map((id) => rowMap.get(id)!),
    columnOrder: source.columnOrder.map((id) => columnMap.get(id)!),
    cells,
  };
  const rows = remapTracks(source.rows, rowMap);
  if (rows) copy.rows = rows;
  else delete copy.rows;
  const columns = remapTracks(source.columns, columnMap);
  if (columns) copy.columns = columns;
  else delete copy.columns;

  if (source.mergedRanges) {
    const merged = source.mergedRanges
      .map((range) => ({
        startRowId: rowMap.get(range.startRowId),
        endRowId: rowMap.get(range.endRowId),
        startColumnId: columnMap.get(range.startColumnId),
        endColumnId: columnMap.get(range.endColumnId),
      }))
      .filter((range): range is SheetRange => Boolean(
        range.startRowId && range.endRowId && range.startColumnId && range.endColumnId,
      ));
    if (merged.length > 0) copy.mergedRanges = merged;
    else delete copy.mergedRanges;
  }

  if (source.tables) {
    const tables = source.tables.flatMap((table): SheetTable[] => {
      const startRowId = rowMap.get(table.range.startRowId);
      const endRowId = rowMap.get(table.range.endRowId);
      const startColumnId = columnMap.get(table.range.startColumnId);
      const endColumnId = columnMap.get(table.range.endColumnId);
      if (!startRowId || !endRowId || !startColumnId || !endColumnId) return [];
      return [{
        ...table,
        id: createSheetTableId(),
        range: { startRowId, endRowId, startColumnId, endColumnId },
        columns: table.columns.flatMap((column) => {
          const columnId = columnMap.get(column.columnId);
          return columnId
            ? [{ ...column, id: createSheetTableColumnId(), columnId }]
            : [];
        }),
      }];
    });
    if (tables.length > 0) copy.tables = tables;
    else delete copy.tables;
  }

  if (source.filters?.range) {
    const startRowId = rowMap.get(source.filters.range.startRowId);
    const endRowId = rowMap.get(source.filters.range.endRowId);
    const startColumnId = columnMap.get(source.filters.range.startColumnId);
    const endColumnId = columnMap.get(source.filters.range.endColumnId);
    if (startRowId && endRowId && startColumnId && endColumnId) {
      copy.filters = {
        range: { startRowId, endRowId, startColumnId, endColumnId },
        sortRules: source.filters.sortRules?.flatMap((rule) => {
          const columnId = columnMap.get(rule.columnId);
          return columnId ? [{ ...rule, columnId }] : [];
        }),
        columnFilters: source.filters.columnFilters?.flatMap((filter) => {
          const columnId = columnMap.get(filter.columnId);
          return columnId ? [{ ...filter, columnId }] : [];
        }),
      };
      if (copy.filters.sortRules?.length === 0) delete copy.filters.sortRules;
      if (copy.filters.columnFilters?.length === 0) delete copy.filters.columnFilters;
    } else {
      delete copy.filters;
    }
  }

  if (source.validations) {
    const validations = source.validations.flatMap((validation): SheetValidation[] => {
      const id = createSheetValidationId();
      validationMap.set(validation.id, id);
      const anchor = validation.anchor
        ? {
          rowId: rowMap.get(validation.anchor.rowId)!,
          columnId: columnMap.get(validation.anchor.columnId)!,
        }
        : undefined;
      if (!validation.sourceRange) return [{ ...validation, id, anchor }];
      const startRowId = rowMap.get(validation.sourceRange.startRowId);
      const endRowId = rowMap.get(validation.sourceRange.endRowId);
      const startColumnId = columnMap.get(validation.sourceRange.startColumnId);
      const endColumnId = columnMap.get(validation.sourceRange.endColumnId);
      return startRowId && endRowId && startColumnId && endColumnId
        ? [{
          ...validation,
          id,
          anchor,
          sourceRange: { startRowId, endRowId, startColumnId, endColumnId },
        }]
        : [];
    });
    if (validations.length > 0) copy.validations = validations;
    else delete copy.validations;
    for (const [key, cell] of Object.entries(copy.cells)) {
      if (!cell.validationId) continue;
      const validationId = validationMap.get(cell.validationId);
      if (validationId) copy.cells[key] = { ...cell, validationId };
      else {
        const repaired = { ...cell };
        delete repaired.validationId;
        if (Object.keys(repaired).length > 0) copy.cells[key] = repaired;
        else delete copy.cells[key];
      }
    }
  }

  if (source.conditionalFormats) {
    const conditionalFormats = source.conditionalFormats.flatMap(
      (format): SheetConditionalFormat[] => {
        const ranges = format.ranges.flatMap((range) => {
          const startRowId = rowMap.get(range.startRowId);
          const endRowId = rowMap.get(range.endRowId);
          const startColumnId = columnMap.get(range.startColumnId);
          const endColumnId = columnMap.get(range.endColumnId);
          return startRowId && endRowId && startColumnId && endColumnId
            ? [{ startRowId, endRowId, startColumnId, endColumnId }]
            : [];
        });
        return ranges.length > 0
          ? [{ ...format, id: createSheetConditionalFormatId(), ranges }]
          : [];
      },
    );
    if (conditionalFormats.length > 0) copy.conditionalFormats = conditionalFormats;
    else delete copy.conditionalFormats;
  }

  if (source.protectedRanges) {
    copy.protectedRanges = source.protectedRanges.map((protectedRange) => ({
      ...protectedRange,
      id: createSheetProtectedRangeId(),
      range: {
        startRowId: rowMap.get(protectedRange.range.startRowId)!,
        endRowId: rowMap.get(protectedRange.range.endRowId)!,
        startColumnId: columnMap.get(protectedRange.range.startColumnId)!,
        endColumnId: columnMap.get(protectedRange.range.endColumnId)!,
      },
    }));
  }

  const index = document.worksheets.findIndex((worksheet) => worksheet.id === worksheetId);
  const worksheets = [...document.worksheets];
  worksheets.splice(index + 1, 0, copy);
  const duplicatedNames = (document.namedRanges ?? []).flatMap((namedRange) => (
    namedRange.scopeWorksheetId === source.id
      ? [{
        ...namedRange,
        id: createSheetNamedRangeId(),
        worksheetId: namedRange.worksheetId === source.id ? copy.id : namedRange.worksheetId,
        range: namedRange.worksheetId === source.id
          ? {
            startRowId: rowMap.get(namedRange.range.startRowId)!,
            endRowId: rowMap.get(namedRange.range.endRowId)!,
            startColumnId: columnMap.get(namedRange.range.startColumnId)!,
            endColumnId: columnMap.get(namedRange.range.endColumnId)!,
          }
          : namedRange.range,
        scopeWorksheetId: copy.id,
      }]
      : []
  ));
  return {
    ...document,
    worksheets,
    activeWorksheetId: copy.id,
    ...((document.namedRanges?.length ?? 0) + duplicatedNames.length > 0
      ? { namedRanges: [...(document.namedRanges ?? []), ...duplicatedNames] }
      : {}),
  };
}

export function reorderWorksheet(
  document: SheetDocument,
  worksheetId: string,
  toIndex: number,
): SheetDocument {
  const from = document.worksheets.findIndex((worksheet) => worksheet.id === worksheetId);
  if (from < 0) return document;
  const target = Math.max(0, Math.min(toIndex, document.worksheets.length - 1));
  if (from === target) return document;
  const worksheets = [...document.worksheets];
  const [moved] = worksheets.splice(from, 1);
  worksheets.splice(target, 0, moved);
  return { ...document, worksheets };
}

/** Hides a worksheet. The workbook must keep at least one visible sheet. */
export function setWorksheetHidden(
  document: SheetDocument,
  worksheetId: string,
  hidden: boolean,
): SheetDocument {
  if (hidden) {
    const visible = document.worksheets.filter((worksheet) => !worksheet.hidden);
    if (visible.length <= 1 && visible[0]?.id === worksheetId) {
      throw new SheetDocumentError(
        'invalid-structure',
        'A workbook must keep at least one visible worksheet.',
      );
    }
  }

  const next = mapWorksheet(document, worksheetId, (worksheet) => {
    if (hidden) return { ...worksheet, hidden: true };
    const { hidden: _removed, ...rest } = worksheet;
    return rest as SheetWorksheet;
  });

  if (hidden && next.activeWorksheetId === worksheetId) {
    const fallback = next.worksheets.find((worksheet) => !worksheet.hidden);
    if (fallback) return { ...next, activeWorksheetId: fallback.id };
  }
  return next;
}

export interface SheetSelectionSummary {
  selected: number;
  /** Cells in the selection that hold anything at all. */
  filled: number;
  /** Cells holding a finite number (formula results are excluded until Phase 3). */
  numeric: number;
  visibleNumeric: number;
  sum: number;
  subtotal: number;
  average: number | null;
  min: number | null;
  max: number | null;
}

/**
 * Status-bar summary for the current selection. Formula cells are counted as
 * filled but not as numeric: their values are not computed until Phase 3, and
 * summing formula *source* would be a lie.
 */
export function summarizeSelection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  computedValues?: SheetFormulaValueMap,
): SheetSelectionSummary {
  let filled = 0;
  let selected = 0;
  let numeric = 0;
  let visibleNumeric = 0;
  let sum = 0;
  let subtotal = 0;
  let min: number | null = null;
  let max: number | null = null;

  for (const position of selectedPositions(selection)) {
    selected += 1;
    const cell = getCell(worksheet, position);
    if (!cell) continue;
    filled += 1;
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    const computed = rowId && columnId
      ? computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
      : undefined;
    const value = numericValueOf(cell, computed);
    if (value === null) continue;
    numeric += 1;
    sum += value;
    if (!worksheet.rows?.[rowId]?.filterHidden) {
      visibleNumeric += 1;
      subtotal += value;
    }
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
  }

  return {
    selected,
    filled,
    numeric,
    visibleNumeric,
    sum,
    subtotal,
    average: numeric > 0 ? sum / numeric : null,
    min,
    max,
  };
}
