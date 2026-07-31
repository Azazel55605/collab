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
import type {
  SheetCell,
  SheetConditionalFormat,
  SheetDocument,
  SheetStyle,
  SheetWorksheet,
} from '../../types/sheet';
import { columnLabel } from './address';
import type { SheetDocumentErrorCode } from './document';

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

/* -------------------------------------------------------------------------- */
/* Phase 9 shape fixtures                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The workbook shapes Phase 9 validates against. Each one stresses a different
 * axis of the model, so a change that only holds for square, lightly formatted
 * grids fails somewhere here.
 */
export type SheetFixtureShape =
  | 'sparse'
  | 'dense'
  | 'wide'
  | 'tall'
  | 'deeplyDependent'
  | 'highlyFormatted';

function workbook(
  name: string,
  worksheets: SheetWorksheet[],
  styles: Record<string, SheetStyle> = {},
): SheetDocument {
  return {
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: 'wb1',
    name,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    activeWorksheetId: worksheets[0].id,
    worksheets,
    styles,
  };
}

function axis(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

/** 100,000 populated cells inside a logical grid roughly 1,000x larger. */
export function createSparseWorkbookFixture(): SheetDocument {
  return createWorkbookFixture({
    rows: 100_000,
    columns: 1_000,
    populatedRows: 1_000,
    populatedColumns: 100,
  });
}

/**
 * Every cell of a small grid populated, cycling through each value type so
 * formatting, comparison, and serialization see more than numbers.
 */
export function createDenseWorkbookFixture(rows = 200, columns = 50): SheetDocument {
  const rowOrder = axis('r', rows);
  const columnOrder = axis('c', columns);
  const cells: Record<string, SheetCell> = {};
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const key = sheetCellKey(rowOrder[row], columnOrder[column]);
      switch ((row + column) % 5) {
        case 0:
          cells[key] = { value: row * columns + column, valueType: 'number' };
          break;
        case 1:
          cells[key] = { value: `${columnLabel(column)}${row + 1}`, valueType: 'text' };
          break;
        case 2:
          cells[key] = { value: (row + column) % 2 === 0, valueType: 'boolean' };
          break;
        case 3:
          cells[key] = { value: '2026-03-04', valueType: 'date' };
          break;
        default:
          cells[key] = { formula: `=${columnLabel(Math.max(0, column - 1))}${row + 1}` };
          break;
      }
    }
  }
  return workbook('Dense fixture', [
    { id: 'ws1', name: 'Dense', rowOrder, columnOrder, cells },
  ]);
}

/** Few rows, near the column ceiling: exercises horizontal metrics and labels. */
export function createWideWorkbookFixture(columns = 8_192, rows = 8): SheetDocument {
  const rowOrder = axis('r', rows);
  const columnOrder = axis('c', columns);
  const cells: Record<string, SheetCell> = {};
  for (let column = 0; column < columns; column += 1) {
    cells[sheetCellKey(rowOrder[0], columnOrder[column])] = {
      value: columnLabel(column),
      valueType: 'text',
    };
    cells[sheetCellKey(rowOrder[1], columnOrder[column])] = {
      value: column + 1,
      valueType: 'number',
    };
  }
  return workbook('Wide fixture', [
    { id: 'ws1', name: 'Wide', rowOrder, columnOrder, cells, frozen: { rows: 1, columns: 0 } },
  ]);
}

/** One tall column: exercises vertical metrics and row-header rendering. */
export function createTallWorkbookFixture(rows = 150_000): SheetDocument {
  const rowOrder = axis('r', rows);
  const columnOrder = axis('c', 4);
  const cells: Record<string, SheetCell> = {};
  for (let row = 0; row < rows; row += 1) {
    cells[sheetCellKey(rowOrder[row], columnOrder[0])] = { value: row + 1, valueType: 'number' };
  }
  return workbook('Tall fixture', [
    { id: 'ws1', name: 'Tall', rowOrder, columnOrder, cells },
  ]);
}

/**
 * A single dependency chain `A1 -> A2 -> ... -> An`. Recalculation must stay
 * dependency-scoped rather than re-evaluating the chain from both ends.
 */
export function createDeepDependencyWorkbookFixture(depth = 5_000): SheetDocument {
  const rowOrder = axis('r', depth);
  const columnOrder = axis('c', 2);
  const cells: Record<string, SheetCell> = {
    [sheetCellKey(rowOrder[0], columnOrder[0])]: { value: 1, valueType: 'number' },
  };
  for (let row = 1; row < depth; row += 1) {
    cells[sheetCellKey(rowOrder[row], columnOrder[0])] = { formula: `=A${row}+1` };
  }
  return workbook('Deep dependency fixture', [
    { id: 'ws1', name: 'Chain', rowOrder, columnOrder, cells },
  ]);
}

/**
 * Style-heavy workbook: a shared style table (never a full style object per
 * cell), merged ranges, and conditional formats.
 */
export function createHighlyFormattedWorkbookFixture(
  rows = 400,
  columns = 40,
  styleCount = 64,
): SheetDocument {
  const rowOrder = axis('r', rows);
  const columnOrder = axis('c', columns);
  const styles: Record<string, SheetStyle> = {};
  for (let index = 0; index < styleCount; index += 1) {
    styles[`s${index + 1}`] = {
      bold: index % 2 === 0,
      italic: index % 3 === 0,
      color: `#${(index * 4).toString(16).padStart(2, '0')}3355`,
      backgroundColor: `#ff${(index * 3).toString(16).padStart(2, '0')}22`,
      horizontalAlign: index % 3 === 0 ? 'center' : 'right',
      numberFormat: index % 4 === 0 ? { kind: 'currency', currencyCode: 'EUR', decimals: 2 } : undefined,
    };
  }

  const cells: Record<string, SheetCell> = {};
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells[sheetCellKey(rowOrder[row], columnOrder[column])] = {
        value: (row + 1) * (column + 1),
        valueType: 'number',
        styleId: `s${((row * columns + column) % styleCount) + 1}`,
      };
    }
  }

  const mergedRanges = Array.from({ length: Math.floor(rows / 8) }, (_, index) => ({
    startRowId: rowOrder[index * 4],
    startColumnId: columnOrder[0],
    endRowId: rowOrder[index * 4],
    endColumnId: columnOrder[2],
  }));

  const conditionalFormats: SheetConditionalFormat[] = Array.from(
    { length: Math.floor(rows / 4) },
    (_, index) => ({
      id: `cf${index + 1}`,
      kind: 'comparison',
      ranges: [
        {
          startRowId: rowOrder[index],
          startColumnId: columnOrder[0],
          endRowId: rowOrder[index],
          endColumnId: columnOrder[columns - 1],
        },
      ],
      operator: 'greater',
      values: [index * 10],
      styleId: `s${(index % styleCount) + 1}`,
    }),
  );

  return workbook(
    'Highly formatted fixture',
    [
      {
        id: 'ws1',
        name: 'Formatted',
        rowOrder,
        columnOrder,
        cells,
        mergedRanges,
        conditionalFormats,
      },
    ],
    styles,
  );
}

/** Every Phase 9 shape fixture, keyed by shape. Generation is lazy — some are large. */
export const SHEET_SHAPE_FIXTURES: Record<SheetFixtureShape, () => SheetDocument> = {
  sparse: createSparseWorkbookFixture,
  dense: () => createDenseWorkbookFixture(),
  wide: () => createWideWorkbookFixture(),
  tall: () => createTallWorkbookFixture(),
  deeplyDependent: () => createDeepDependencyWorkbookFixture(),
  highlyFormatted: () => createHighlyFormattedWorkbookFixture(),
};

/* -------------------------------------------------------------------------- */
/* Corrupted workbooks                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How the document boundary must handle a damaged workbook.
 *
 * `rejected` means the file cannot be trusted at all and opening must fail with
 * a typed error. `repaired` means the damage is local and recoverable, in which
 * case the workbook opens but the repair must be reported — never applied
 * silently, because the user's stored content changed.
 */
export type CorruptSheetOutcome =
  | { kind: 'rejected'; code: SheetDocumentErrorCode }
  | { kind: 'repaired'; warning: RegExp };

export interface CorruptSheetFixture {
  name: string;
  /** Stored file content, exactly as a damaged vault file would contain it. */
  text: string;
  outcome: CorruptSheetOutcome;
}

const VALID_MINIMAL = {
  kind: SHEET_DOCUMENT_KIND,
  schemaVersion: SHEET_SCHEMA_VERSION,
  id: 'wb1',
  name: 'Corrupt fixture',
  createdAt: FIXED_TIMESTAMP,
  updatedAt: FIXED_TIMESTAMP,
  worksheets: [{ id: 'ws1', name: 'Sheet1', rowOrder: ['r1'], columnOrder: ['c1'], cells: {} }],
  styles: {},
};

function mutated(mutate: (document: Record<string, unknown>) => void): string {
  const clone = JSON.parse(JSON.stringify(VALID_MINIMAL)) as Record<string, unknown>;
  mutate(clone);
  return JSON.stringify(clone);
}

/**
 * Damaged workbooks that must fail safely: a clear typed rejection, never a
 * partially loaded document, a silent truncation, or a hang.
 */
export const CORRUPT_SHEET_FIXTURES: CorruptSheetFixture[] = [
  {
    name: 'truncated json',
    text: '{"kind":"collab-sheet","worksheets":[',
    outcome: { kind: 'rejected', code: 'invalid-json' },
  },
  { name: 'json array', text: '[1,2,3]', outcome: { kind: 'rejected', code: 'not-an-object' } },
  { name: 'json null', text: 'null', outcome: { kind: 'rejected', code: 'not-an-object' } },
  { name: 'json string', text: '"a workbook"', outcome: { kind: 'rejected', code: 'not-an-object' } },
  {
    name: 'wrong document kind',
    text: mutated((document) => {
      document.kind = 'collab-kanban';
    }),
    outcome: { kind: 'rejected', code: 'wrong-kind' },
  },
  {
    name: 'non-numeric schema version',
    text: mutated((document) => {
      document.schemaVersion = 'one';
    }),
    outcome: { kind: 'rejected', code: 'invalid-schema-version' },
  },
  {
    name: 'zero schema version',
    text: mutated((document) => {
      document.schemaVersion = 0;
    }),
    outcome: { kind: 'rejected', code: 'invalid-schema-version' },
  },
  {
    name: 'too many worksheets',
    text: mutated((document) => {
      document.worksheets = Array.from({ length: 201 }, (_, index) => ({
        id: `ws${index + 1}`,
        name: `Sheet${index + 1}`,
        rowOrder: ['r1'],
        columnOrder: ['c1'],
        cells: {},
      }));
    }),
    outcome: { kind: 'rejected', code: 'limit-exceeded' },
  },
  {
    name: 'worksheets not an array',
    text: mutated((document) => {
      document.worksheets = { ws1: {} };
    }),
    outcome: { kind: 'repaired', warning: /Added a worksheet because the workbook had none/ },
  },
  {
    name: 'no worksheets',
    text: mutated((document) => {
      document.worksheets = [];
    }),
    outcome: { kind: 'repaired', warning: /Added a worksheet because the workbook had none/ },
  },
  {
    name: 'row id containing the cell-key separator',
    text: mutated((document) => {
      (document.worksheets as Record<string, unknown>[])[0].rowOrder = ['r:1'];
    }),
    outcome: { kind: 'repaired', warning: /Repaired 1 invalid or duplicate row identifier/ },
  },
  {
    name: 'duplicate row ids',
    text: mutated((document) => {
      (document.worksheets as Record<string, unknown>[])[0].rowOrder = ['r1', 'r1'];
    }),
    outcome: { kind: 'repaired', warning: /Repaired 1 invalid or duplicate row identifier/ },
  },
  {
    name: 'cells pointing at rows that no longer exist',
    text: mutated((document) => {
      (document.worksheets as Record<string, unknown>[])[0].cells = {
        'r1:c1': { value: 1, valueType: 'number' },
        'rGone:c1': { value: 2, valueType: 'number' },
      };
    }),
    outcome: { kind: 'repaired', warning: /Dropped 1 cell\(s\)/ },
  },
  {
    name: 'duplicate worksheet names',
    text: mutated((document) => {
      const worksheets = document.worksheets as Record<string, unknown>[];
      worksheets.push({ ...worksheets[0], id: 'ws2' });
    }),
    outcome: { kind: 'repaired', warning: /Renamed duplicate worksheet/ },
  },
];
