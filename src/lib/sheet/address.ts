/**
 * Translation between the `.sheet` stable-ID model and the A1 notation users
 * and the formula engine speak.
 *
 * The document never stores A1 references as position truth: `rowOrder` and
 * `columnOrder` are truth, and A1 is derived. That is what lets a row insert
 * shift every downstream reference without rewriting unrelated cells.
 */

import type {
  SheetCellKey,
  SheetColumnId,
  SheetRange,
  SheetRowId,
  SheetWorksheet,
} from '../../types/sheet';
import { sheetCellKey } from '../../types/sheet';

/** 0-based column index to a spreadsheet column label (`0` -> `A`, `26` -> `AA`). */
export function columnLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`column index must be a non-negative integer, got ${index}`);
  }
  let label = '';
  let remaining = index;
  while (remaining >= 0) {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return label;
}

/** Column label to a 0-based index. Returns null for anything that is not a label. */
export function columnIndex(label: string): number | null {
  if (!/^[A-Za-z]+$/.test(label)) return null;
  let index = 0;
  for (const character of label.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

export interface SheetPosition {
  row: number;
  column: number;
}

/** Parses `A1`, `$A$1`, `b12` into 0-based coordinates. */
export function parseA1(reference: string): SheetPosition | null {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(reference.trim());
  if (!match) return null;
  const column = columnIndex(match[1]);
  if (column === null) return null;
  const row = Number.parseInt(match[2], 10);
  if (!Number.isFinite(row) || row < 1) return null;
  return { row: row - 1, column };
}

export function formatA1(position: SheetPosition): string {
  return `${columnLabel(position.column)}${position.row + 1}`;
}

/**
 * Positional index over one worksheet.
 *
 * Built once per structural change and reused for lookups, so translating a
 * viewport full of cells stays O(1) per cell instead of scanning `rowOrder`.
 */
export class SheetAddressIndex {
  private readonly rowIds: readonly SheetRowId[];
  private readonly columnIds: readonly SheetColumnId[];
  private readonly rowPositions: Map<SheetRowId, number>;
  private readonly columnPositions: Map<SheetColumnId, number>;

  constructor(worksheet: Pick<SheetWorksheet, 'rowOrder' | 'columnOrder'>) {
    this.rowIds = worksheet.rowOrder;
    this.columnIds = worksheet.columnOrder;
    this.rowPositions = new Map(worksheet.rowOrder.map((id, index) => [id, index]));
    this.columnPositions = new Map(worksheet.columnOrder.map((id, index) => [id, index]));
  }

  get rowCount(): number {
    return this.rowIds.length;
  }

  get columnCount(): number {
    return this.columnIds.length;
  }

  rowIdAt(index: number): SheetRowId | null {
    return this.rowIds[index] ?? null;
  }

  columnIdAt(index: number): SheetColumnId | null {
    return this.columnIds[index] ?? null;
  }

  rowIndexOf(rowId: SheetRowId): number | null {
    return this.rowPositions.get(rowId) ?? null;
  }

  columnIndexOf(columnId: SheetColumnId): number | null {
    return this.columnPositions.get(columnId) ?? null;
  }

  cellKeyAt(position: SheetPosition): SheetCellKey | null {
    const rowId = this.rowIdAt(position.row);
    const columnId = this.columnIdAt(position.column);
    if (rowId === null || columnId === null) return null;
    return sheetCellKey(rowId, columnId);
  }

  positionOf(rowId: SheetRowId, columnId: SheetColumnId): SheetPosition | null {
    const row = this.rowIndexOf(rowId);
    const column = this.columnIndexOf(columnId);
    if (row === null || column === null) return null;
    return { row, column };
  }

  /** A1 label for a stable cell identity, or null if either ID is dangling. */
  a1For(rowId: SheetRowId, columnId: SheetColumnId): string | null {
    const position = this.positionOf(rowId, columnId);
    return position ? formatA1(position) : null;
  }

  /** Stable cell key for an A1 reference, or null if it falls outside the sheet. */
  cellKeyForA1(reference: string): SheetCellKey | null {
    const position = parseA1(reference);
    return position ? this.cellKeyAt(position) : null;
  }

  /** A1 range label (`A1:C3`) for a stable range, or null if any bound is dangling. */
  a1ForRange(range: SheetRange): string | null {
    const start = this.positionOf(range.startRowId, range.startColumnId);
    const end = this.positionOf(range.endRowId, range.endColumnId);
    if (!start || !end) return null;
    const topLeft = { row: Math.min(start.row, end.row), column: Math.min(start.column, end.column) };
    const bottomRight = { row: Math.max(start.row, end.row), column: Math.max(start.column, end.column) };
    return `${formatA1(topLeft)}:${formatA1(bottomRight)}`;
  }
}
