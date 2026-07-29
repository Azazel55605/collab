/**
 * `.sheet` workbook schema — frozen in Phase 0 of the Advanced Tables plan.
 *
 * See `docs/plans/advanced-tables-phase0-contract.md` for the rules behind
 * these shapes. The short version:
 *
 * - Rows, columns, worksheets, styles, and charts have stable IDs. Cells are
 *   sparse and keyed by `${rowId}:${columnId}`, so inserting a row never
 *   rewrites unrelated cells and collaboration can address a cell that has
 *   moved.
 * - Formula source is authoritative. Computed values are derived and are never
 *   persisted here.
 * - Dates and times are stored as ISO-8601 strings, not serial numbers. The
 *   formula adapter converts to serials at the engine boundary.
 * - No field may carry executable or externally fetched content.
 */

export const SHEET_EXTENSION = 'sheet';
export const SHEET_MEDIA_TYPE = 'application/vnd.collab.sheet+json';
export const SHEET_DOCUMENT_KIND = 'collab-sheet';
export const SHEET_SCHEMA_VERSION = 1;

/**
 * Hard structural limits. These bound parsing, import, paste, and
 * collaboration; they are not UI preferences. A document exceeding any limit is
 * rejected rather than truncated silently.
 */
export const SHEET_LIMITS = {
  worksheetsPerWorkbook: 200,
  rowsPerWorksheet: 1_000_000,
  columnsPerWorksheet: 16_384,
  populatedCellsPerWorksheet: 500_000,
  populatedCellsPerWorkbook: 1_000_000,
  formulaCellsPerWorkbook: 200_000,
  formulaSourceLength: 8_192,
  cellTextLength: 32_768,
  worksheetNameLength: 64,
  stylesPerWorkbook: 10_000,
  namedRangesPerWorkbook: 1_000,
  mergedRangesPerWorksheet: 10_000,
  conditionalFormatsPerWorksheet: 500,
  chartsPerWorksheet: 50,
  documentBytes: 64 * 1024 * 1024,
} as const;

export type SheetValueType = 'blank' | 'text' | 'number' | 'boolean' | 'date' | 'time' | 'datetime';

/**
 * Stable spreadsheet error codes. Mirrors `SheetFormulaError` in
 * `crates/collab-sheet`; keep both in sync.
 */
export type SheetErrorCode =
  | '#NULL!'
  | '#REF!'
  | '#NAME?'
  | '#VALUE!'
  | '#DIV/0!'
  | '#N/A'
  | '#NUM!'
  | '#SPILL!'
  | '#CALC!'
  | '#CIRC!'
  | '#N/IMPL!'
  | '#ERROR!'
  | '#TIMEOUT!';

export type SheetRowId = string;
export type SheetColumnId = string;
export type SheetWorksheetId = string;
export type SheetStyleId = string;

/** `${rowId}:${columnId}` — the sparse cell map key. */
export type SheetCellKey = string;

export interface SheetRow {
  id: SheetRowId;
  /** Height in CSS pixels. Omitted means the worksheet default. */
  height?: number;
  hidden?: boolean;
  styleId?: SheetStyleId;
}

export interface SheetColumn {
  id: SheetColumnId;
  /** Width in CSS pixels. Omitted means the worksheet default. */
  width?: number;
  hidden?: boolean;
  styleId?: SheetStyleId;
}

export interface SheetCell {
  /**
   * Literal value. Dates, times, and datetimes are ISO-8601 strings paired with
   * the matching `valueType`.
   */
  value?: string | number | boolean | null;
  valueType?: SheetValueType;
  /** Formula source including the leading `=`. Authoritative when present. */
  formula?: string;
  styleId?: SheetStyleId;
  note?: string;
  validationId?: string;
  /** Vault-relative path or wikilink target, for cell-level Collab links. */
  link?: string;
}

/** A rectangular range expressed in stable row/column IDs. */
export interface SheetRange {
  startRowId: SheetRowId;
  startColumnId: SheetColumnId;
  endRowId: SheetRowId;
  endColumnId: SheetColumnId;
}

export type SheetHorizontalAlign = 'left' | 'center' | 'right';
export type SheetVerticalAlign = 'top' | 'middle' | 'bottom';
export type SheetBorderStyle = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted';

export interface SheetBorderSide {
  style: SheetBorderStyle;
  color?: string;
}

export interface SheetBorders {
  top?: SheetBorderSide;
  right?: SheetBorderSide;
  bottom?: SheetBorderSide;
  left?: SheetBorderSide;
}

/**
 * A reusable cell style. Styles are deduplicated at the workbook level and
 * referenced by ID so a formatted range does not store one object per cell.
 */
export interface SheetStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Explicit document color. Theme-derived defaults stay client-rendered. */
  color?: string;
  backgroundColor?: string;
  horizontalAlign?: SheetHorizontalAlign;
  verticalAlign?: SheetVerticalAlign;
  wrap?: boolean;
  indent?: number;
  borders?: SheetBorders;
  /** Display format only. It never changes the stored value. */
  numberFormat?: SheetNumberFormat;
}

export type SheetNumberFormatKind =
  | 'general'
  | 'number'
  | 'percent'
  | 'currency'
  | 'date'
  | 'time'
  | 'datetime'
  | 'text'
  | 'custom';

export interface SheetNumberFormat {
  kind: SheetNumberFormatKind;
  decimals?: number;
  useThousandsSeparator?: boolean;
  currencyCode?: string;
  /** Pattern for `kind: 'custom'`. Purely declarative — never evaluated. */
  pattern?: string;
}

export type SheetValidationKind = 'list' | 'range' | 'number' | 'date' | 'text' | 'custom';

export interface SheetValidation {
  id: string;
  kind: SheetValidationKind;
  /** Literal options for `kind: 'list'`. */
  options?: string[];
  /** Source range for `kind: 'range'`. */
  sourceRange?: SheetRange;
  min?: number | string;
  max?: number | string;
  /** Formula source for `kind: 'custom'`, evaluated by the formula engine. */
  formula?: string;
  /** Reject invalid input outright, or accept it with a warning. */
  strict?: boolean;
  message?: string;
}

export type SheetConditionalFormatKind =
  | 'comparison'
  | 'formula'
  | 'colorScale'
  | 'duplicateValues'
  | 'uniqueValues';

export interface SheetConditionalFormat {
  id: string;
  kind: SheetConditionalFormatKind;
  ranges: SheetRange[];
  operator?: 'equal' | 'notEqual' | 'greater' | 'greaterOrEqual' | 'less' | 'lessOrEqual' | 'between' | 'contains';
  values?: (string | number)[];
  formula?: string;
  styleId?: SheetStyleId;
  /** Ordered stops for `kind: 'colorScale'`. */
  colorScale?: { position: number; color: string }[];
}

export type SheetChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'sparkline';

export interface SheetChartSeries {
  id: string;
  name?: string;
  valuesRange: SheetRange;
  categoriesRange?: SheetRange;
  color?: string;
}

export interface SheetChart {
  id: string;
  kind: SheetChartKind;
  title?: string;
  series: SheetChartSeries[];
  /** Anchor in stable IDs so structural edits keep the chart attached. */
  anchor: { rowId: SheetRowId; columnId: SheetColumnId; width: number; height: number };
  /** Accessibility summary rendered alongside the chart. */
  description?: string;
}

export type SheetSortDirection = 'ascending' | 'descending';

export interface SheetSortRule {
  columnId: SheetColumnId;
  direction: SheetSortDirection;
}

export interface SheetColumnFilter {
  columnId: SheetColumnId;
  /** Values kept visible. Omitted means "all values". */
  includeValues?: (string | number | boolean | null)[];
  hideBlanks?: boolean;
  textContains?: string;
  numberMin?: number;
  numberMax?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface SheetFilterState {
  range?: SheetRange;
  sortRules?: SheetSortRule[];
  columnFilters?: SheetColumnFilter[];
}

export interface SheetNamedRange {
  id: string;
  name: string;
  worksheetId: SheetWorksheetId;
  range: SheetRange;
  /** Workbook-wide when absent, worksheet-local when set. */
  scopeWorksheetId?: SheetWorksheetId;
}

export interface SheetWorksheet {
  id: SheetWorksheetId;
  name: string;
  /** Row order is positional truth; `rows` only carries rows with properties. */
  rowOrder: SheetRowId[];
  columnOrder: SheetColumnId[];
  rows?: Record<SheetRowId, SheetRow>;
  columns?: Record<SheetColumnId, SheetColumn>;
  /** Sparse cell map keyed by `${rowId}:${columnId}`. */
  cells: Record<SheetCellKey, SheetCell>;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
  hidden?: boolean;
  mergedRanges?: SheetRange[];
  frozen?: { rows: number; columns: number };
  filters?: SheetFilterState;
  validations?: SheetValidation[];
  conditionalFormats?: SheetConditionalFormat[];
  charts?: SheetChart[];
}

export interface SheetDocument {
  kind: typeof SHEET_DOCUMENT_KIND;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  activeWorksheetId?: SheetWorksheetId;
  worksheets: SheetWorksheet[];
  styles: Record<SheetStyleId, SheetStyle>;
  namedRanges?: SheetNamedRange[];
  /** Forward-compatible bag for unknown-but-preserved fields. */
  metadata?: Record<string, unknown>;
}

export const SHEET_DEFAULTS = {
  rowHeight: 24,
  columnWidth: 100,
  headerHeight: 24,
  headerWidth: 48,
  /** Rows/columns rendered beyond the visible window on each side. */
  overscan: 4,
} as const;

export function sheetCellKey(rowId: SheetRowId, columnId: SheetColumnId): SheetCellKey {
  return `${rowId}:${columnId}`;
}

export function parseSheetCellKey(key: SheetCellKey): { rowId: SheetRowId; columnId: SheetColumnId } | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { rowId: key.slice(0, separator), columnId: key.slice(separator + 1) };
}
