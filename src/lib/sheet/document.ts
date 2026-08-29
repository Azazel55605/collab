/**
 * `.sheet` document domain: creation, parsing, validation, normalization,
 * serialization, and migration.
 *
 * Rules this module enforces, from
 * `docs/plans/advanced-tables-phase0-contract.md`:
 *
 * - Row, column, worksheet, style, and chart identities are stable and must
 *   never contain `:` (the cell-key separator).
 * - Cells are sparse and are dropped when they reference a row or column the
 *   worksheet no longer has, so a malformed file opens instead of failing.
 * - Unknown fields are preserved verbatim at document, worksheet, and cell
 *   level, so a file written by a newer build survives a round trip here.
 * - A workbook from a newer schema version is never silently downgraded: it is
 *   reported as read-only rather than normalized into this build's shape.
 *
 * The bounded structural counterpart on the Rust side is
 * `crates/collab-documents/src/sheet.rs`; keep the limits in step.
 */
import {
  parseSheetCellKey,
  SHEET_DEFAULTS,
  SHEET_DOCUMENT_KIND,
  SHEET_LIMITS,
  SHEET_SCHEMA_VERSION,
  sheetCellKey,
} from '../../types/sheet';
import type {
  SheetCell,
  SheetCellAttachment,
  SheetChart,
  SheetChartKind,
  SheetColumn,
  SheetColumnFilter,
  SheetDataConnection,
  SheetDocument,
  SheetFilterState,
  SheetNamedRange,
  SheetRange,
  SheetRow,
  SheetTable,
  SheetValueType,
  SheetWorksheet,
} from '../../types/sheet';

import { rewriteDocumentFormulaReferences } from './formulaReferences';

export type SheetDocumentErrorCode =
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-kind'
  | 'invalid-schema-version'
  | 'invalid-structure'
  | 'limit-exceeded';

export class SheetDocumentError extends Error {
  readonly code: SheetDocumentErrorCode;

  constructor(code: SheetDocumentErrorCode, message: string) {
    super(message);
    this.name = 'SheetDocumentError';
    this.code = code;
  }
}

/**
 * How this build can handle a stored workbook.
 * - `supported`: normalize and edit freely.
 * - `newer`: readable identity only — the document must be opened read-only so
 *   an older build cannot strip fields it does not understand.
 */
export type SheetSchemaSupport = 'supported' | 'newer';

export interface SheetDocumentInspection {
  support: SheetSchemaSupport;
  schemaVersion: number;
  document: SheetDocument;
  /** Non-fatal repairs applied while normalizing (dropped cells, renames, …). */
  warnings: string[];
}

const VALUE_TYPES: ReadonlySet<string> = new Set<SheetValueType>([
  'blank',
  'text',
  'number',
  'boolean',
  'date',
  'time',
  'datetime',
]);

const KNOWN_DOCUMENT_KEYS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'name',
  'createdAt',
  'updatedAt',
  'activeWorksheetId',
  'worksheets',
  'styles',
  'namedRanges',
  'dataConnections',
  'metadata',
]);

const KNOWN_WORKSHEET_KEYS = new Set([
  'id',
  'name',
  'rowOrder',
  'columnOrder',
  'rows',
  'columns',
  'cells',
  'defaultRowHeight',
  'defaultColumnWidth',
  'hidden',
  'mergedRanges',
  'frozen',
  'filters',
  'tables',
  'validations',
  'conditionalFormats',
  'protectedRanges',
  'charts',
]);

const KNOWN_CELL_KEYS = new Set([
  'value',
  'valueType',
  'formula',
  'styleId',
  'note',
  'validationId',
  'link',
  'attachments',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Valid stable identity: non-empty and free of the cell-key separator. */
export function isValidSheetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes(':');
}

function unknownKeys(record: Record<string, unknown>, known: Set<string>) {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

function newId(prefix: string) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function createSheetRowId() {
  return newId('r');
}

export function createSheetColumnId() {
  return newId('c');
}

export function createSheetTableId() {
  return newId('tbl');
}

export function createSheetTableColumnId() {
  return newId('tc');
}

export function createSheetValidationId() {
  return newId('val');
}

export function createSheetConditionalFormatId() {
  return newId('cf');
}

export function createSheetProtectedRangeId() {
  return newId('pr');
}

export function createSheetNamedRangeId() {
  return newId('nr');
}

export function createSheetChartId() {
  return newId('chart');
}

export function createSheetChartSeriesId() {
  return newId('series');
}

export function createSheetAttachmentId() {
  return newId('att');
}

export function createSheetDataConnectionId() {
  return newId('conn');
}

export function createSheetWorksheetId() {
  return newId('ws');
}

export interface CreateWorksheetOptions {
  id?: string;
  name?: string;
  rows?: number;
  columns?: number;
}

export function createEmptyWorksheet(options: CreateWorksheetOptions = {}): SheetWorksheet {
  const rows = Math.max(1, Math.min(options.rows ?? 100, SHEET_LIMITS.rowsPerWorksheet));
  const columns = Math.max(1, Math.min(options.columns ?? 26, SHEET_LIMITS.columnsPerWorksheet));
  return {
    id: options.id ?? createSheetWorksheetId(),
    name: options.name ?? 'Sheet1',
    rowOrder: Array.from({ length: rows }, () => createSheetRowId()),
    columnOrder: Array.from({ length: columns }, () => createSheetColumnId()),
    cells: {},
    defaultRowHeight: SHEET_DEFAULTS.rowHeight,
    defaultColumnWidth: SHEET_DEFAULTS.columnWidth,
    frozen: { rows: 0, columns: 0 },
  };
}

export interface CreateWorkbookOptions {
  id?: string;
  timestamp?: string;
  worksheet?: CreateWorksheetOptions;
}

export function createEmptySheetDocument(
  name: string,
  options: CreateWorkbookOptions = {},
): SheetDocument {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const worksheet = createEmptyWorksheet(options.worksheet);
  return {
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: options.id ?? newId('wb'),
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    activeWorksheetId: worksheet.id,
    worksheets: [worksheet],
    styles: {},
  };
}

interface NormalizeContext {
  warnings: string[];
}

function normalizeIdList(
  value: unknown,
  create: () => string,
  limit: number,
  label: string,
  context: NormalizeContext,
): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  let repaired = 0;

  for (const candidate of source) {
    if (ids.length >= limit) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${limit} ${label}s.`,
      );
    }
    let id = isValidSheetId(candidate) ? candidate : '';
    if (!id || seen.has(id)) {
      id = create();
      repaired += 1;
    }
    seen.add(id);
    ids.push(id);
  }

  if (ids.length === 0) {
    ids.push(create());
    repaired += 1;
  }
  if (repaired > 0) {
    context.warnings.push(`Repaired ${repaired} invalid or duplicate ${label} identifier(s).`);
  }
  return ids;
}

function normalizeCell(value: unknown): SheetCell | null {
  const record = asRecord(value);
  if (!record) return null;

  const cell: SheetCell = { ...unknownKeys(record, KNOWN_CELL_KEYS) };

  if ('value' in record) {
    const raw = record.value;
    if (
      raw === null ||
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean'
    ) {
      cell.value = raw;
    }
  }
  if (typeof record.valueType === 'string' && VALUE_TYPES.has(record.valueType)) {
    cell.valueType = record.valueType as SheetValueType;
  }
  if (typeof record.formula === 'string' && record.formula.length > 0) {
    cell.formula = record.formula;
  }
  if (isValidSheetId(record.styleId)) cell.styleId = record.styleId;
  if (typeof record.note === 'string') cell.note = record.note;
  if (typeof record.validationId === 'string') cell.validationId = record.validationId;
  if (typeof record.link === 'string') cell.link = record.link;
  if (Array.isArray(record.attachments)) {
    const ids = new Set<string>();
    const attachments = record.attachments.flatMap((raw): SheetCellAttachment[] => {
      const attachment = asRecord(raw);
      if (
        !attachment ||
        typeof attachment.relativePath !== 'string' ||
        !attachment.relativePath.trim()
      ) {
        return [];
      }
      const id =
        isValidSheetId(attachment.id) && !ids.has(attachment.id)
          ? attachment.id
          : createSheetAttachmentId();
      ids.add(id);
      return [
        {
          id,
          relativePath: attachment.relativePath.trim(),
          ...(typeof attachment.label === 'string' && attachment.label.trim()
            ? { label: attachment.label.trim() }
            : {}),
        },
      ];
    });
    if (attachments.length > 0) cell.attachments = attachments;
  }

  const meaningful =
    cell.value !== undefined ||
    cell.formula !== undefined ||
    cell.styleId !== undefined ||
    cell.note !== undefined ||
    cell.link !== undefined ||
    cell.attachments !== undefined ||
    cell.validationId !== undefined;
  return meaningful ? cell : null;
}

function normalizeTrackProperties<T extends SheetRow | SheetColumn>(
  value: unknown,
  ids: Set<string>,
  sizeKey: 'height' | 'width',
): Record<string, T> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const out: Record<string, T> = {};
  for (const [id, raw] of Object.entries(record)) {
    if (!ids.has(id)) continue;
    const properties = asRecord(raw);
    if (!properties) continue;
    const track = { id } as T;
    const size = positiveNumber(properties[sizeKey]);
    if (size !== undefined) (track as unknown as Record<string, unknown>)[sizeKey] = size;
    if (properties.hidden === true) track.hidden = true;
    if (sizeKey === 'height' && properties.filterHidden === true) {
      (track as SheetRow).filterHidden = true;
    }
    if (isValidSheetId(properties.styleId)) track.styleId = properties.styleId;
    out[id] = track;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeStableRange(
  value: unknown,
  rowIds: Set<string>,
  columnIds: Set<string>,
): SheetRange | null {
  const range = asRecord(value);
  if (!range) return null;
  const startRowId = String(range.startRowId);
  const endRowId = String(range.endRowId);
  const startColumnId = String(range.startColumnId);
  const endColumnId = String(range.endColumnId);
  return rowIds.has(startRowId) &&
    rowIds.has(endRowId) &&
    columnIds.has(startColumnId) &&
    columnIds.has(endColumnId)
    ? { startRowId, endRowId, startColumnId, endColumnId }
    : null;
}

function normalizeWorksheet(value: unknown, context: NormalizeContext): SheetWorksheet {
  const record = asRecord(value);
  if (!record) {
    throw new SheetDocumentError('invalid-structure', 'Each worksheet must be an object.');
  }

  const rowOrder = normalizeIdList(
    record.rowOrder,
    createSheetRowId,
    SHEET_LIMITS.rowsPerWorksheet,
    'row',
    context,
  );
  const columnOrder = normalizeIdList(
    record.columnOrder,
    createSheetColumnId,
    SHEET_LIMITS.columnsPerWorksheet,
    'column',
    context,
  );
  const rowIds = new Set(rowOrder);
  const columnIds = new Set(columnOrder);

  const cellsRecord = asRecord(record.cells) ?? {};
  const cells: Record<string, SheetCell> = {};
  let dropped = 0;
  // Counted rather than derived from `Object.keys(cells).length`: recomputing
  // the key list per cell makes opening a large worksheet quadratic.
  let kept = 0;
  for (const [key, raw] of Object.entries(cellsRecord)) {
    const parsed = parseSheetCellKey(key);
    if (!parsed || !rowIds.has(parsed.rowId) || !columnIds.has(parsed.columnId)) {
      dropped += 1;
      continue;
    }
    const cell = normalizeCell(raw);
    if (!cell) {
      dropped += 1;
      continue;
    }
    if (kept >= SHEET_LIMITS.populatedCellsPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.populatedCellsPerWorksheet} populated cells.`,
      );
    }
    cells[sheetCellKey(parsed.rowId, parsed.columnId)] = cell;
    kept += 1;
  }
  if (dropped > 0) {
    context.warnings.push(`Dropped ${dropped} cell(s) with a missing row, column, or value.`);
  }

  const worksheet: SheetWorksheet = {
    ...unknownKeys(record, KNOWN_WORKSHEET_KEYS),
    id: isValidSheetId(record.id) ? record.id : createSheetWorksheetId(),
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.slice(0, SHEET_LIMITS.worksheetNameLength)
        : 'Sheet',
    rowOrder,
    columnOrder,
    cells,
  };

  const rows = normalizeTrackProperties<SheetRow>(record.rows, rowIds, 'height');
  if (rows) worksheet.rows = rows;
  const columns = normalizeTrackProperties<SheetColumn>(record.columns, columnIds, 'width');
  if (columns) worksheet.columns = columns;

  const defaultRowHeight = positiveNumber(record.defaultRowHeight);
  if (defaultRowHeight) worksheet.defaultRowHeight = defaultRowHeight;
  const defaultColumnWidth = positiveNumber(record.defaultColumnWidth);
  if (defaultColumnWidth) worksheet.defaultColumnWidth = defaultColumnWidth;
  if (record.hidden === true) worksheet.hidden = true;

  const frozen = asRecord(record.frozen);
  if (frozen) {
    worksheet.frozen = {
      rows: Math.min(positiveNumber(frozen.rows) ?? 0, rowOrder.length),
      columns: Math.min(positiveNumber(frozen.columns) ?? 0, columnOrder.length),
    };
  }

  // Structures whose interiors later phases own are carried through unchanged
  // once their references resolve, so Phase 1 never silently discards them.
  if (Array.isArray(record.mergedRanges)) {
    const merged = record.mergedRanges.filter((range) => {
      const item = asRecord(range);
      return (
        item &&
        rowIds.has(String(item.startRowId)) &&
        rowIds.has(String(item.endRowId)) &&
        columnIds.has(String(item.startColumnId)) &&
        columnIds.has(String(item.endColumnId))
      );
    });
    if (merged.length !== record.mergedRanges.length) {
      context.warnings.push('Dropped merged range(s) pointing at missing rows or columns.');
    }
    if (merged.length > 0) worksheet.mergedRanges = merged as SheetWorksheet['mergedRanges'];
  }
  if (Array.isArray(record.tables)) {
    const tableIds = new Set<string>();
    const tables = record.tables.flatMap((table): SheetTable[] => {
      const item = asRecord(table);
      const range = normalizeStableRange(item?.range, rowIds, columnIds);
      if (!item || !range || !Array.isArray(item.columns)) return [];
      const left = columnOrder.indexOf(range.startColumnId);
      const right = columnOrder.indexOf(range.endColumnId);
      const rangeColumnIds = new Set(
        columnOrder.slice(Math.min(left, right), Math.max(left, right) + 1),
      );
      const columnIdentity = new Set<string>();
      const columns = item.columns.flatMap((rawColumn) => {
        const column = asRecord(rawColumn);
        if (!column || !rangeColumnIds.has(String(column.columnId))) return [];
        const id =
          isValidSheetId(column.id) && !columnIdentity.has(column.id)
            ? column.id
            : createSheetTableColumnId();
        columnIdentity.add(id);
        return [
          {
            ...column,
            id,
            name:
              typeof column.name === 'string' && column.name.trim()
                ? column.name.trim()
                : `Column ${columnIdentity.size}`,
            columnId: String(column.columnId),
          },
        ];
      });
      if (columns.length !== rangeColumnIds.size) return [];
      const id = isValidSheetId(item.id) && !tableIds.has(item.id) ? item.id : createSheetTableId();
      tableIds.add(id);
      return [
        {
          ...item,
          id,
          name:
            typeof item.name === 'string' && item.name.trim()
              ? item.name.trim()
              : `Table${tableIds.size}`,
          range,
          hasHeaderRow: item.hasHeaderRow !== false,
          columns,
        },
      ];
    });
    if (tables.length !== record.tables.length) {
      context.warnings.push('Dropped table(s) with invalid or missing row/column references.');
    }
    if (tables.length > SHEET_LIMITS.tablesPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.tablesPerWorksheet} tables.`,
      );
    }
    if (tables.length > 0) worksheet.tables = tables as SheetWorksheet['tables'];
  }
  const rawFilters = asRecord(record.filters);
  if (rawFilters) {
    const range = normalizeStableRange(rawFilters.range, rowIds, columnIds);
    if (range) {
      const filters: SheetFilterState = { range };
      if (Array.isArray(rawFilters.sortRules)) {
        filters.sortRules = rawFilters.sortRules.flatMap((rawRule) => {
          const rule = asRecord(rawRule);
          return rule &&
            columnIds.has(String(rule.columnId)) &&
            (rule.direction === 'ascending' || rule.direction === 'descending')
            ? [{ columnId: String(rule.columnId), direction: rule.direction }]
            : [];
        });
      }
      if (Array.isArray(rawFilters.columnFilters)) {
        filters.columnFilters = rawFilters.columnFilters.flatMap((rawFilter) => {
          const filter = asRecord(rawFilter);
          return filter && columnIds.has(String(filter.columnId))
            ? [{ ...filter, columnId: String(filter.columnId) } as SheetColumnFilter]
            : [];
        });
      }
      worksheet.filters = filters;
    } else {
      context.warnings.push('Dropped filters with invalid or missing row/column references.');
    }
  }
  if (Array.isArray(record.validations)) {
    if (record.validations.length > SHEET_LIMITS.validationsPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.validationsPerWorksheet} validation rules.`,
      );
    }
    const validationIds = new Set<string>();
    const kinds = new Set(['list', 'range', 'number', 'date', 'text', 'custom']);
    const validations = record.validations.flatMap((rawValidation) => {
      const validation = asRecord(rawValidation);
      if (!validation || !kinds.has(String(validation.kind))) return [];
      const id =
        isValidSheetId(validation.id) && !validationIds.has(validation.id)
          ? validation.id
          : createSheetValidationId();
      validationIds.add(id);
      const sourceRange =
        validation.sourceRange === undefined
          ? undefined
          : normalizeStableRange(validation.sourceRange, rowIds, columnIds);
      if (validation.kind === 'range' && !sourceRange) return [];
      const anchorRecord = asRecord(validation.anchor);
      let anchor =
        anchorRecord &&
        rowIds.has(String(anchorRecord.rowId)) &&
        columnIds.has(String(anchorRecord.columnId))
          ? { rowId: String(anchorRecord.rowId), columnId: String(anchorRecord.columnId) }
          : undefined;
      if (validation.kind === 'custom') {
        if (typeof validation.formula !== 'string' || !validation.formula.startsWith('='))
          return [];
        if (!anchor) {
          const firstCell = Object.entries(worksheet.cells).find(
            ([, cell]) => cell.validationId === id,
          );
          const parsed = firstCell ? parseSheetCellKey(firstCell[0]) : null;
          if (parsed) anchor = { rowId: parsed.rowId, columnId: parsed.columnId };
        }
        if (!anchor) return [];
      }
      return [
        {
          ...validation,
          id,
          kind: String(validation.kind),
          sourceRange: sourceRange ?? undefined,
          anchor,
        },
      ];
    }) as NonNullable<SheetWorksheet['validations']>;
    if (validations.length !== record.validations.length) {
      context.warnings.push('Dropped invalid data validation rule(s).');
    }
    if (validations.length > 0) worksheet.validations = validations;
    const validIds = new Set(validations.map((validation) => validation.id));
    for (const [key, cell] of Object.entries(worksheet.cells)) {
      if (!cell.validationId || validIds.has(cell.validationId)) continue;
      const next = { ...cell };
      delete next.validationId;
      if (Object.keys(next).length > 0) worksheet.cells[key] = next;
      else delete worksheet.cells[key];
      context.warnings.push('Cleared a cell reference to a missing validation rule.');
    }
  } else {
    let cleared = 0;
    for (const [key, cell] of Object.entries(worksheet.cells)) {
      if (!cell.validationId) continue;
      const next = { ...cell };
      delete next.validationId;
      if (Object.keys(next).length > 0) worksheet.cells[key] = next;
      else delete worksheet.cells[key];
      cleared += 1;
    }
    if (cleared > 0) {
      context.warnings.push(`Cleared ${cleared} cell reference(s) to missing validation rules.`);
    }
  }
  if (Array.isArray(record.conditionalFormats)) {
    if (record.conditionalFormats.length > SHEET_LIMITS.conditionalFormatsPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.conditionalFormatsPerWorksheet} conditional formats.`,
      );
    }
    const formatIds = new Set<string>();
    const kinds = new Set([
      'comparison',
      'formula',
      'colorScale',
      'duplicateValues',
      'uniqueValues',
    ]);
    const conditionalFormats = record.conditionalFormats.flatMap((rawFormat) => {
      const format = asRecord(rawFormat);
      if (!format || !kinds.has(String(format.kind)) || !Array.isArray(format.ranges)) return [];
      const ranges = format.ranges.flatMap((range) => {
        const normalized = normalizeStableRange(range, rowIds, columnIds);
        return normalized ? [normalized] : [];
      });
      if (ranges.length === 0 || ranges.length !== format.ranges.length) return [];
      if (
        format.kind === 'formula' &&
        (typeof format.formula !== 'string' || !format.formula.startsWith('='))
      )
        return [];
      const id =
        isValidSheetId(format.id) && !formatIds.has(format.id)
          ? format.id
          : createSheetConditionalFormatId();
      formatIds.add(id);
      return [
        {
          ...format,
          id,
          kind: String(format.kind),
          ranges,
        },
      ];
    }) as NonNullable<SheetWorksheet['conditionalFormats']>;
    if (conditionalFormats.length !== record.conditionalFormats.length) {
      context.warnings.push('Dropped invalid conditional formatting rule(s).');
    }
    if (conditionalFormats.length > 0) worksheet.conditionalFormats = conditionalFormats;
  }
  if (Array.isArray(record.protectedRanges)) {
    if (record.protectedRanges.length > SHEET_LIMITS.protectedRangesPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.protectedRangesPerWorksheet} protected ranges.`,
      );
    }
    const ids = new Set<string>();
    const protectedRanges = record.protectedRanges.flatMap((rawRange) => {
      const item = asRecord(rawRange);
      const range = item ? normalizeStableRange(item.range, rowIds, columnIds) : null;
      if (!item || !range) return [];
      const id =
        isValidSheetId(item.id) && !ids.has(item.id) ? item.id : createSheetProtectedRangeId();
      ids.add(id);
      return [
        {
          ...item,
          id,
          range,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
        },
      ];
    }) as NonNullable<SheetWorksheet['protectedRanges']>;
    if (protectedRanges.length !== record.protectedRanges.length) {
      context.warnings.push('Dropped invalid protected range(s).');
    }
    if (protectedRanges.length > 0) worksheet.protectedRanges = protectedRanges;
  }
  if (Array.isArray(record.charts)) {
    if (record.charts.length > SHEET_LIMITS.chartsPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.chartsPerWorksheet} charts.`,
      );
    }
    const chartIds = new Set<string>();
    const chartKinds = new Set<SheetChartKind>([
      'column',
      'bar',
      'line',
      'area',
      'pie',
      'scatter',
      'sparkline',
    ]);
    const charts = record.charts.flatMap((rawChart): SheetChart[] => {
      const chart = asRecord(rawChart);
      const anchor = asRecord(chart?.anchor);
      if (
        !chart ||
        !chartKinds.has(chart.kind as SheetChartKind) ||
        !anchor ||
        !rowIds.has(String(anchor.rowId)) ||
        !columnIds.has(String(anchor.columnId)) ||
        !Array.isArray(chart.series)
      ) {
        return [];
      }
      const seriesIds = new Set<string>();
      const series = chart.series.flatMap((rawSeries) => {
        const item = asRecord(rawSeries);
        const valuesRange = item ? normalizeStableRange(item.valuesRange, rowIds, columnIds) : null;
        const categoriesRange =
          item?.categoriesRange === undefined
            ? undefined
            : normalizeStableRange(item.categoriesRange, rowIds, columnIds);
        if (!item || !valuesRange || (item.categoriesRange !== undefined && !categoriesRange)) {
          return [];
        }
        const id =
          isValidSheetId(item.id) && !seriesIds.has(item.id) ? item.id : createSheetChartSeriesId();
        seriesIds.add(id);
        return [
          {
            id,
            valuesRange,
            ...(categoriesRange ? { categoriesRange } : {}),
            ...(typeof item.name === 'string' && item.name.trim()
              ? { name: item.name.trim() }
              : {}),
            ...(typeof item.color === 'string' && item.color.trim()
              ? { color: item.color.trim() }
              : {}),
          },
        ];
      });
      if (series.length === 0 || series.length !== chart.series.length) return [];
      const id =
        isValidSheetId(chart.id) && !chartIds.has(chart.id) ? chart.id : createSheetChartId();
      chartIds.add(id);
      return [
        {
          id,
          kind: chart.kind as SheetChartKind,
          ...(typeof chart.title === 'string' && chart.title.trim()
            ? { title: chart.title.trim() }
            : {}),
          series,
          anchor: {
            rowId: String(anchor.rowId),
            columnId: String(anchor.columnId),
            width: Math.max(120, Math.min(1_600, positiveNumber(anchor.width) ?? 480)),
            height: Math.max(80, Math.min(1_200, positiveNumber(anchor.height) ?? 280)),
          },
          ...(typeof chart.description === 'string' && chart.description.trim()
            ? { description: chart.description.trim() }
            : {}),
        },
      ];
    });
    if (charts.length !== record.charts.length) {
      context.warnings.push('Dropped chart(s) with invalid or missing row/column references.');
    }
    if (charts.length > 0) worksheet.charts = charts;
  }

  return worksheet;
}

/**
 * Coerces arbitrary input into a valid workbook, repairing what is safely
 * repairable and reporting it. Throws only when the input cannot represent a
 * workbook at all, or when it exceeds a hard limit.
 */
export function normalizeSheetDocument(input: unknown, name = 'Workbook'): SheetDocumentInspection {
  const record = asRecord(input);
  if (!record) {
    throw new SheetDocumentError('not-an-object', 'A .sheet file must contain a JSON object.');
  }
  if (record.kind !== SHEET_DOCUMENT_KIND) {
    throw new SheetDocumentError(
      'wrong-kind',
      `A .sheet file must declare kind "${SHEET_DOCUMENT_KIND}".`,
    );
  }

  const schemaVersion =
    typeof record.schemaVersion === 'number' &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion >= 1
      ? record.schemaVersion
      : null;
  if (schemaVersion === null) {
    throw new SheetDocumentError(
      'invalid-schema-version',
      'A .sheet file must declare a positive integer schemaVersion.',
    );
  }

  if (schemaVersion > SHEET_SCHEMA_VERSION) {
    // Do not normalize: this build would strip fields it does not know about.
    return {
      support: 'newer',
      schemaVersion,
      document: record as unknown as SheetDocument,
      warnings: [],
    };
  }

  const context: NormalizeContext = { warnings: [] };
  const migrated = migrateSheetDocument(record, schemaVersion, context);

  const worksheetSource = Array.isArray(migrated.worksheets) ? migrated.worksheets : [];
  if (worksheetSource.length > SHEET_LIMITS.worksheetsPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.worksheetsPerWorkbook} worksheets.`,
    );
  }

  const worksheets = worksheetSource.map((worksheet) => normalizeWorksheet(worksheet, context));
  if (worksheets.length === 0) {
    worksheets.push(createEmptyWorksheet());
    context.warnings.push('Added a worksheet because the workbook had none.');
  }

  const worksheetIds = new Set<string>();
  const names = new Set<string>();
  for (const worksheet of worksheets) {
    while (worksheetIds.has(worksheet.id)) {
      worksheet.id = createSheetWorksheetId();
      context.warnings.push('Renumbered a duplicate worksheet identifier.');
    }
    worksheetIds.add(worksheet.id);

    let candidate = worksheet.name;
    let suffix = 2;
    while (names.has(candidate.toLowerCase())) {
      candidate = `${worksheet.name} (${suffix})`;
      suffix += 1;
    }
    if (candidate !== worksheet.name) {
      context.warnings.push(`Renamed duplicate worksheet "${worksheet.name}" to "${candidate}".`);
      worksheet.name = candidate;
    }
    names.add(candidate.toLowerCase());
  }

  let totalCells = 0;
  for (const worksheet of worksheets) totalCells += Object.keys(worksheet.cells).length;
  if (totalCells > SHEET_LIMITS.populatedCellsPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.populatedCellsPerWorkbook} populated cells.`,
    );
  }

  const stylesRecord = asRecord(migrated.styles) ?? {};
  if (Object.keys(stylesRecord).length > SHEET_LIMITS.stylesPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.stylesPerWorkbook} styles.`,
    );
  }
  const styles: SheetDocument['styles'] = {};
  for (const [id, style] of Object.entries(stylesRecord)) {
    if (isValidSheetId(id) && asRecord(style))
      styles[id] = style as SheetDocument['styles'][string];
  }

  // A style a cell points at must exist; otherwise drop the reference rather
  // than the cell, so no user content is lost.
  let danglingStyles = 0;
  for (const worksheet of worksheets) {
    for (const cell of Object.values(worksheet.cells)) {
      if (cell.styleId && !styles[cell.styleId]) {
        delete cell.styleId;
        danglingStyles += 1;
      }
    }
    for (const track of Object.values(worksheet.rows ?? {})) {
      if (track.styleId && !styles[track.styleId]) {
        delete track.styleId;
        danglingStyles += 1;
      }
    }
    for (const track of Object.values(worksheet.columns ?? {})) {
      if (track.styleId && !styles[track.styleId]) {
        delete track.styleId;
        danglingStyles += 1;
      }
    }
    for (const format of worksheet.conditionalFormats ?? []) {
      if (format.styleId && !styles[format.styleId]) {
        delete format.styleId;
        danglingStyles += 1;
      }
    }
  }
  if (danglingStyles > 0) {
    context.warnings.push(`Cleared ${danglingStyles} reference(s) to a missing style.`);
  }

  const activeWorksheetId = optionalString(migrated.activeWorksheetId);
  const timestamp = new Date().toISOString();
  if (
    Array.isArray(migrated.namedRanges) &&
    migrated.namedRanges.length > SHEET_LIMITS.namedRangesPerWorkbook
  ) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.namedRangesPerWorkbook} named ranges.`,
    );
  }
  const namedRangeIds = new Set<string>();
  const acceptedNames: Array<{ name: string; scopeWorksheetId?: string }> = [];
  const namedRanges = Array.isArray(migrated.namedRanges)
    ? migrated.namedRanges.flatMap((rawRange): SheetNamedRange[] => {
        const item = asRecord(rawRange);
        if (!item || typeof item.name !== 'string' || !item.name.trim()) return [];
        const worksheet = worksheets.find((candidate) => candidate.id === item.worksheetId);
        if (!worksheet) return [];
        const hasScope =
          Object.prototype.hasOwnProperty.call(item, 'scopeWorksheetId') &&
          item.scopeWorksheetId !== undefined;
        if (
          hasScope &&
          (typeof item.scopeWorksheetId !== 'string' || !worksheetIds.has(item.scopeWorksheetId))
        )
          return [];
        const scopeWorksheetId = hasScope ? (item.scopeWorksheetId as string) : undefined;
        const range = normalizeStableRange(
          item.range,
          new Set(worksheet.rowOrder),
          new Set(worksheet.columnOrder),
        );
        if (!range) return [];
        const name = item.name.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || /^[A-Za-z]{1,3}[1-9]\d*$/.test(name))
          return [];
        const normalizedName = name.toLocaleLowerCase();
        const conflicts = acceptedNames.some(
          (accepted) =>
            accepted.name === normalizedName &&
            (accepted.scopeWorksheetId === undefined ||
              scopeWorksheetId === undefined ||
              accepted.scopeWorksheetId === scopeWorksheetId),
        );
        if (conflicts) return [];
        acceptedNames.push({ name: normalizedName, scopeWorksheetId });
        const id =
          isValidSheetId(item.id) && !namedRangeIds.has(item.id)
            ? item.id
            : createSheetNamedRangeId();
        namedRangeIds.add(id);
        return [
          {
            ...item,
            id,
            name,
            worksheetId: worksheet.id,
            range,
            scopeWorksheetId,
          },
        ];
      })
    : undefined;
  if (
    namedRanges &&
    Array.isArray(migrated.namedRanges) &&
    namedRanges.length !== migrated.namedRanges.length
  ) {
    context.warnings.push('Dropped invalid or conflicting named range(s).');
  }

  if (
    Array.isArray(migrated.dataConnections) &&
    migrated.dataConnections.length > SHEET_LIMITS.dataConnectionsPerWorkbook
  ) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.dataConnectionsPerWorkbook} data connections.`,
    );
  }
  const connectionIds = new Set<string>();
  const dataConnections = Array.isArray(migrated.dataConnections)
    ? migrated.dataConnections.flatMap((rawConnection): SheetDataConnection[] => {
        const connection = asRecord(rawConnection);
        if (
          !connection ||
          (connection.kind !== 'kanbanTasks' && connection.kind !== 'calendarItems') ||
          typeof connection.targetWorksheetId !== 'string'
        )
          return [];
        const worksheet = worksheets.find(
          (candidate) => candidate.id === connection.targetWorksheetId,
        );
        if (!worksheet) return [];
        const targetRange = normalizeStableRange(
          connection.targetRange,
          new Set(worksheet.rowOrder),
          new Set(worksheet.columnOrder),
        );
        if (!targetRange || !Array.isArray(connection.columns)) return [];
        const columns = connection.columns.flatMap((rawColumn) => {
          const column = asRecord(rawColumn);
          return column &&
            typeof column.key === 'string' &&
            typeof column.label === 'string' &&
            typeof column.columnId === 'string' &&
            worksheet.columnOrder.includes(column.columnId)
            ? [
                {
                  key: column.key,
                  label: column.label,
                  columnId: column.columnId,
                },
              ]
            : [];
        });
        if (columns.length === 0 || columns.length !== connection.columns.length) return [];
        const id =
          isValidSheetId(connection.id) && !connectionIds.has(connection.id)
            ? connection.id
            : createSheetDataConnectionId();
        connectionIds.add(id);
        return [
          {
            id,
            kind: connection.kind,
            ...(typeof connection.sourcePath === 'string' && connection.sourcePath.trim()
              ? { sourcePath: connection.sourcePath.trim() }
              : {}),
            ...(typeof connection.calendarId === 'string' && connection.calendarId.trim()
              ? { calendarId: connection.calendarId.trim() }
              : {}),
            targetWorksheetId: worksheet.id,
            targetRange,
            columns,
            refreshedAt: optionalString(connection.refreshedAt) ?? new Date(0).toISOString(),
            itemCount: Math.max(0, Math.floor(positiveNumber(connection.itemCount) ?? 0)),
          },
        ];
      })
    : undefined;
  if (
    dataConnections &&
    Array.isArray(migrated.dataConnections) &&
    dataConnections.length !== migrated.dataConnections.length
  ) {
    context.warnings.push('Dropped invalid data connection(s).');
  }

  const document: SheetDocument = {
    ...unknownKeys(migrated, KNOWN_DOCUMENT_KEYS),
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: optionalString(migrated.id) ?? newId('wb'),
    name: optionalString(migrated.name) ?? name,
    createdAt: optionalString(migrated.createdAt) ?? timestamp,
    updatedAt: optionalString(migrated.updatedAt) ?? timestamp,
    activeWorksheetId:
      activeWorksheetId && worksheetIds.has(activeWorksheetId)
        ? activeWorksheetId
        : worksheets[0].id,
    worksheets,
    styles,
  };
  if (namedRanges && namedRanges.length > 0) document.namedRanges = namedRanges;
  if (dataConnections && dataConnections.length > 0) {
    document.dataConnections = dataConnections;
  }
  const metadata = asRecord(migrated.metadata);
  if (metadata) document.metadata = metadata;

  return {
    support: 'supported',
    schemaVersion,
    document,
    warnings: context.warnings,
  };
}

/**
 * Upgrades an older stored version to the current one.
 *
 * Schema version 1 is the first version, so there is nothing to migrate yet.
 * Every future version must add an explicit step here — never an implicit
 * "normalize and hope", which is how silent data loss happens.
 */
export function migrateSheetDocument(
  record: Record<string, unknown>,
  fromVersion: number,
  context: NormalizeContext,
): Record<string, unknown> {
  if (fromVersion === SHEET_SCHEMA_VERSION) return record;
  context.warnings.push(
    `Upgraded workbook from schema version ${fromVersion} to ${SHEET_SCHEMA_VERSION}.`,
  );
  return record;
}

/** Parses `.sheet` text, reporting schema support and any repairs. */
export function inspectSheetDocumentText(text: string, name = 'Workbook'): SheetDocumentInspection {
  if (!text.trim()) {
    return {
      support: 'supported',
      schemaVersion: SHEET_SCHEMA_VERSION,
      document: createEmptySheetDocument(name),
      warnings: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SheetDocumentError('invalid-json', 'The .sheet file does not contain valid JSON.');
  }
  return normalizeSheetDocument(parsed, name);
}

/** Convenience wrapper for callers that only want an editable workbook. */
export function parseSheetDocument(text: string, name = 'Workbook'): SheetDocument {
  const inspection = inspectSheetDocumentText(text, name);
  if (inspection.support === 'newer') {
    throw new SheetDocumentError(
      'invalid-schema-version',
      `This workbook uses schema version ${inspection.schemaVersion}, which this version of Collab cannot edit.`,
    );
  }
  return inspection.document;
}

/**
 * Deterministic serialization. Key order follows the schema declaration order
 * so two clients writing equivalent workbooks produce identical bytes.
 */
export function serializeSheetDocument(document: SheetDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function countPopulatedCells(document: SheetDocument): number {
  return document.worksheets.reduce(
    (total, worksheet) => total + Object.keys(worksheet.cells).length,
    0,
  );
}

export function countFormulaCells(document: SheetDocument): number {
  return document.worksheets.reduce(
    (total, worksheet) =>
      total +
      Object.values(worksheet.cells).filter((cell) => typeof cell.formula === 'string').length,
    0,
  );
}

/** Adds a worksheet with a name that does not collide with an existing one. */
export function addWorksheet(document: SheetDocument, requestedName?: string): SheetDocument {
  if (document.worksheets.length >= SHEET_LIMITS.worksheetsPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.worksheetsPerWorkbook} worksheets.`,
    );
  }
  const taken = new Set(document.worksheets.map((worksheet) => worksheet.name.toLowerCase()));
  const base = requestedName?.trim() || `Sheet${document.worksheets.length + 1}`;
  let name = base;
  let suffix = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base} (${suffix})`;
    suffix += 1;
  }
  const worksheet = createEmptyWorksheet({ name });
  return {
    ...document,
    worksheets: [...document.worksheets, worksheet],
    activeWorksheetId: worksheet.id,
  };
}

export function renameWorksheet(
  document: SheetDocument,
  worksheetId: string,
  requestedName: string,
): SheetDocument {
  const name = requestedName.trim().slice(0, SHEET_LIMITS.worksheetNameLength);
  if (!name) {
    throw new SheetDocumentError('invalid-structure', 'A worksheet name cannot be empty.');
  }
  const collides = document.worksheets.some(
    (worksheet) =>
      worksheet.id !== worksheetId && worksheet.name.toLowerCase() === name.toLowerCase(),
  );
  if (collides) {
    throw new SheetDocumentError(
      'invalid-structure',
      `This workbook already has a worksheet named "${name}".`,
    );
  }
  const next = {
    ...document,
    worksheets: document.worksheets.map((worksheet) =>
      worksheet.id === worksheetId ? { ...worksheet, name } : worksheet,
    ),
  };
  return rewriteDocumentFormulaReferences(document, next);
}

/**
 * Removes a worksheet. A workbook always keeps at least one, and references to
 * the removed worksheet are cleaned up rather than left dangling.
 */
export function removeWorksheet(document: SheetDocument, worksheetId: string): SheetDocument {
  if (document.worksheets.length <= 1) {
    throw new SheetDocumentError(
      'invalid-structure',
      'A workbook must contain at least one worksheet.',
    );
  }
  const worksheets = document.worksheets.filter((worksheet) => worksheet.id !== worksheetId);
  if (worksheets.length === document.worksheets.length) return document;

  const next: SheetDocument = {
    ...document,
    worksheets,
    activeWorksheetId:
      document.activeWorksheetId === worksheetId ? worksheets[0].id : document.activeWorksheetId,
  };
  if (next.namedRanges) {
    const kept = next.namedRanges.filter(
      (range) => range.worksheetId !== worksheetId && range.scopeWorksheetId !== worksheetId,
    );
    if (kept.length > 0) next.namedRanges = kept;
    else delete next.namedRanges;
  }
  return rewriteDocumentFormulaReferences(document, next);
}
