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
  SHEET_DEFAULTS,
  SHEET_DOCUMENT_KIND,
  SHEET_LIMITS,
  SHEET_SCHEMA_VERSION,
  sheetCellKey,
  parseSheetCellKey,
} from '../../types/sheet';
import type {
  SheetCell,
  SheetColumn,
  SheetDocument,
  SheetRow,
  SheetValueType,
  SheetWorksheet,
} from '../../types/sheet';

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
  'validations',
  'conditionalFormats',
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
    if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
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

  const meaningful = cell.value !== undefined
    || cell.formula !== undefined
    || cell.styleId !== undefined
    || cell.note !== undefined
    || cell.link !== undefined
    || cell.validationId !== undefined;
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
    if (isValidSheetId(properties.styleId)) track.styleId = properties.styleId;
    out[id] = track;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    if (Object.keys(cells).length >= SHEET_LIMITS.populatedCellsPerWorksheet) {
      throw new SheetDocumentError(
        'limit-exceeded',
        `A worksheet may not have more than ${SHEET_LIMITS.populatedCellsPerWorksheet} populated cells.`,
      );
    }
    cells[sheetCellKey(parsed.rowId, parsed.columnId)] = cell;
  }
  if (dropped > 0) {
    context.warnings.push(`Dropped ${dropped} cell(s) with a missing row, column, or value.`);
  }

  const worksheet: SheetWorksheet = {
    ...unknownKeys(record, KNOWN_WORKSHEET_KEYS),
    id: isValidSheetId(record.id) ? record.id : createSheetWorksheetId(),
    name: typeof record.name === 'string' && record.name.trim()
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
      return item
        && rowIds.has(String(item.startRowId))
        && rowIds.has(String(item.endRowId))
        && columnIds.has(String(item.startColumnId))
        && columnIds.has(String(item.endColumnId));
    });
    if (merged.length !== record.mergedRanges.length) {
      context.warnings.push('Dropped merged range(s) pointing at missing rows or columns.');
    }
    if (merged.length > 0) worksheet.mergedRanges = merged as SheetWorksheet['mergedRanges'];
  }
  if (asRecord(record.filters)) worksheet.filters = record.filters as SheetWorksheet['filters'];
  if (Array.isArray(record.validations)) {
    worksheet.validations = record.validations as SheetWorksheet['validations'];
  }
  if (Array.isArray(record.conditionalFormats)) {
    worksheet.conditionalFormats = record.conditionalFormats as SheetWorksheet['conditionalFormats'];
  }
  if (Array.isArray(record.charts)) {
    worksheet.charts = record.charts as SheetWorksheet['charts'];
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

  const schemaVersion = typeof record.schemaVersion === 'number'
    && Number.isInteger(record.schemaVersion)
    && record.schemaVersion >= 1
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
    if (isValidSheetId(id) && asRecord(style)) styles[id] = style as SheetDocument['styles'][string];
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
  }
  if (danglingStyles > 0) {
    context.warnings.push(`Cleared ${danglingStyles} reference(s) to a missing style.`);
  }

  const activeWorksheetId = optionalString(migrated.activeWorksheetId);
  const timestamp = new Date().toISOString();
  const namedRanges = Array.isArray(migrated.namedRanges)
    ? (migrated.namedRanges as SheetDocument['namedRanges'])!.filter(
      (range) => worksheetIds.has(range.worksheetId),
    )
    : undefined;
  if (namedRanges && Array.isArray(migrated.namedRanges)
    && namedRanges.length !== migrated.namedRanges.length) {
    context.warnings.push('Dropped named range(s) pointing at a missing worksheet.');
  }

  const document: SheetDocument = {
    ...unknownKeys(migrated, KNOWN_DOCUMENT_KEYS),
    kind: SHEET_DOCUMENT_KIND,
    schemaVersion: SHEET_SCHEMA_VERSION,
    id: optionalString(migrated.id) ?? newId('wb'),
    name: optionalString(migrated.name) ?? name,
    createdAt: optionalString(migrated.createdAt) ?? timestamp,
    updatedAt: optionalString(migrated.updatedAt) ?? timestamp,
    activeWorksheetId: activeWorksheetId && worksheetIds.has(activeWorksheetId)
      ? activeWorksheetId
      : worksheets[0].id,
    worksheets,
    styles,
  };
  if (namedRanges && namedRanges.length > 0) document.namedRanges = namedRanges;
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
    (total, worksheet) => total + Object.values(worksheet.cells)
      .filter((cell) => typeof cell.formula === 'string').length,
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
    (worksheet) => worksheet.id !== worksheetId && worksheet.name.toLowerCase() === name.toLowerCase(),
  );
  if (collides) {
    throw new SheetDocumentError(
      'invalid-structure',
      `This workbook already has a worksheet named "${name}".`,
    );
  }
  return {
    ...document,
    worksheets: document.worksheets.map(
      (worksheet) => (worksheet.id === worksheetId ? { ...worksheet, name } : worksheet),
    ),
  };
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
    activeWorksheetId: document.activeWorksheetId === worksheetId
      ? worksheets[0].id
      : document.activeWorksheetId,
  };
  if (next.namedRanges) {
    const kept = next.namedRanges.filter((range) => range.worksheetId !== worksheetId);
    if (kept.length > 0) next.namedRanges = kept;
    else delete next.namedRanges;
  }
  return next;
}
