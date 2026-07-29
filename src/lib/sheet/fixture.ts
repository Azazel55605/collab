/**
 * Deterministic `.sheet` fixtures.
 *
 * Phase 0 uses these to prove the sparse model: a workbook with 100,000
 * populated cells inside a logical grid several orders of magnitude larger.
 * Later phases reuse them for schema, editor, and performance tests, so keep
 * generation deterministic — no `Math.random`, no clock reads.
 */

import {
  SHEET_DOCUMENT_KIND,
  SHEET_SCHEMA_VERSION,
  sheetCellKey,
} from '../../types/sheet';
import type { SheetCell, SheetDocument, SheetWorksheet } from '../../types/sheet';
import { columnLabel } from './address';

export interface SheetFixtureOptions {
  /** Logical row count of the worksheet. */
  rows: number;
  /** Logical column count of the worksheet. */
  columns: number;
  /** Populated cells, filled row-major from the top-left. */
  populatedRows: number;
  populatedColumns: number;
  /** Add a trailing formula column summing each populated row. */
  formulaColumn?: boolean;
  worksheetName?: string;
  /** Fixed timestamp so fixtures are byte-stable. */
  timestamp?: string;
}

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export function createWorksheetFixture(options: SheetFixtureOptions): SheetWorksheet {
  const rowOrder = Array.from({ length: options.rows }, (_, index) => `r${index + 1}`);
  const columnOrder = Array.from({ length: options.columns }, (_, index) => `c${index + 1}`);
  const cells: Record<string, SheetCell> = {};

  const populatedRows = Math.min(options.populatedRows, options.rows);
  const populatedColumns = Math.min(options.populatedColumns, options.columns);

  for (let row = 0; row < populatedRows; row += 1) {
    for (let column = 0; column < populatedColumns; column += 1) {
      cells[sheetCellKey(rowOrder[row], columnOrder[column])] = {
        value: (row + 1) * (column + 1),
        valueType: 'number',
      };
    }
  }

  if (options.formulaColumn && populatedColumns > 0 && populatedColumns < options.columns) {
    const formulaColumnId = columnOrder[populatedColumns];
    for (let row = 0; row < populatedRows; row += 1) {
      cells[sheetCellKey(rowOrder[row], formulaColumnId)] = {
        formula: `=SUM(A${row + 1}:${columnLabel(populatedColumns - 1)}${row + 1})`,
      };
    }
  }

  return {
    id: 'ws1',
    name: options.worksheetName ?? 'Sheet1',
    rowOrder,
    columnOrder,
    cells,
    frozen: { rows: 1, columns: 1 },
  };
}

export function createWorkbookFixture(options: SheetFixtureOptions): SheetDocument {
  const timestamp = options.timestamp ?? FIXED_TIMESTAMP;
  return {
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: 'wb1',
    name: 'Fixture workbook',
    createdAt: timestamp,
    updatedAt: timestamp,
    activeWorksheetId: 'ws1',
    worksheets: [createWorksheetFixture(options)],
    styles: {},
  };
}
