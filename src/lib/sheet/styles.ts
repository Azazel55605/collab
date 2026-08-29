import { SHEET_LIMITS, sheetCellKey } from '../../types/sheet';
import type {
  SheetCell,
  SheetColumn,
  SheetDocument,
  SheetRow,
  SheetStyle,
  SheetStyleId,
  SheetWorksheet,
} from '../../types/sheet';

import type { SheetPosition } from './address';
import { SheetDocumentError } from './document';
import { normalizeRange, selectedPositions, type SheetSelection } from './selection';

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, compactValue(entry)]),
  );
}

export function canonicalStyle(style: SheetStyle): SheetStyle {
  return compactValue(style) as SheetStyle;
}

export function sheetStyleKey(style: SheetStyle): string {
  return JSON.stringify(canonicalStyle(style));
}

function hashStyleKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function styleIdFor(
  styles: SheetDocument['styles'],
  style: SheetStyle,
): { styles: SheetDocument['styles']; styleId: SheetStyleId | undefined } {
  const canonical = canonicalStyle(style);
  const key = sheetStyleKey(canonical);
  if (key === '{}') return { styles, styleId: undefined };

  for (const [styleId, existing] of Object.entries(styles)) {
    if (sheetStyleKey(existing) === key) return { styles, styleId };
  }
  if (Object.keys(styles).length >= SHEET_LIMITS.stylesPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.stylesPerWorkbook} styles.`,
    );
  }

  const base = `style-${hashStyleKey(key)}`;
  let styleId = base;
  let suffix = 2;
  while (styles[styleId] && sheetStyleKey(styles[styleId]) !== key) {
    styleId = `${base}-${suffix}`;
    suffix += 1;
  }
  return { styles: { ...styles, [styleId]: canonical }, styleId };
}

function mergeStyle(base: SheetStyle | undefined, patch: Partial<SheetStyle>): SheetStyle {
  return canonicalStyle({ ...(base ?? {}), ...patch });
}

function referencedStyleIds(document: SheetDocument): Set<string> {
  const ids = new Set<string>();
  for (const worksheet of document.worksheets) {
    for (const cell of Object.values(worksheet.cells)) {
      if (cell.styleId) ids.add(cell.styleId);
    }
    for (const row of Object.values(worksheet.rows ?? {})) {
      if (row.styleId) ids.add(row.styleId);
    }
    for (const column of Object.values(worksheet.columns ?? {})) {
      if (column.styleId) ids.add(column.styleId);
    }
    for (const format of worksheet.conditionalFormats ?? []) {
      if (format.styleId) ids.add(format.styleId);
    }
  }
  return ids;
}

export function registerSheetStyle(
  document: SheetDocument,
  style: SheetStyle,
): { document: SheetDocument; styleId: SheetStyleId | undefined } {
  const result = styleIdFor(document.styles, style);
  return {
    document: result.styles === document.styles ? document : { ...document, styles: result.styles },
    styleId: result.styleId,
  };
}

export function pruneUnusedSheetStyles(document: SheetDocument): SheetDocument {
  const used = referencedStyleIds(document);
  const styles = Object.fromEntries(
    Object.entries(document.styles).filter(([styleId]) => used.has(styleId)),
  );
  return Object.keys(styles).length === Object.keys(document.styles).length
    ? document
    : { ...document, styles };
}

export function resolveCellStyle(
  styles: SheetDocument['styles'],
  worksheet: SheetWorksheet,
  position: SheetPosition,
): SheetStyle {
  const rowId = worksheet.rowOrder[position.row];
  const columnId = worksheet.columnOrder[position.column];
  if (!rowId || !columnId) return {};
  const columnStyle = styles[worksheet.columns?.[columnId]?.styleId ?? ''];
  const rowStyle = styles[worksheet.rows?.[rowId]?.styleId ?? ''];
  const cellStyle = styles[worksheet.cells[sheetCellKey(rowId, columnId)]?.styleId ?? ''];
  return canonicalStyle({
    ...(columnStyle ?? {}),
    ...(rowStyle ?? {}),
    ...(cellStyle ?? {}),
  });
}

function applyTrackStyle(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  patch: Partial<SheetStyle>,
  axis: 'row' | 'column',
): SheetDocument {
  const indexes = new Set<number>();
  for (const range of selection.ranges) {
    const rectangle = normalizeRange(range);
    const from = axis === 'row' ? rectangle.top : rectangle.left;
    const to = axis === 'row' ? rectangle.bottom : rectangle.right;
    for (let index = from; index <= to; index += 1) indexes.add(index);
  }

  let styles = document.styles;
  const tracks: Record<string, SheetRow | SheetColumn> = {
    ...(axis === 'row' ? worksheet.rows : worksheet.columns),
  };
  const order = axis === 'row' ? worksheet.rowOrder : worksheet.columnOrder;
  for (const index of indexes) {
    const id = order[index];
    if (!id) continue;
    const track = tracks[id] ?? { id };
    const current = styles[track.styleId ?? ''];
    const result = styleIdFor(styles, mergeStyle(current, patch));
    styles = result.styles;
    tracks[id] = result.styleId
      ? { ...track, styleId: result.styleId }
      : (Object.fromEntries(Object.entries(track).filter(([key]) => key !== 'styleId')) as
          SheetRow | SheetColumn);
  }

  const worksheets = document.worksheets.map((candidate) =>
    candidate.id !== worksheet.id
      ? candidate
      : axis === 'row'
        ? { ...candidate, rows: tracks as SheetWorksheet['rows'] }
        : { ...candidate, columns: tracks as SheetWorksheet['columns'] },
  );
  return pruneUnusedSheetStyles({ ...document, styles, worksheets });
}

/** Applies a style patch without changing any stored values or formulas. */
/** One entry of a batched per-cell style write. */
export interface SheetCellStyleWrite {
  position: SheetPosition;
  patch: Partial<SheetStyle>;
}

/**
 * Applies a different style patch to each of many cells in one pass.
 *
 * Paste and import need this: folding `applyStyleToSelection` over single-cell
 * selections copies the sparse map and prunes the style table once per cell,
 * which is quadratic in the worksheet size. Repeated patches are also resolved
 * through a local key cache so a uniformly styled paste registers each distinct
 * style once instead of rescanning the style table per cell.
 */
export function applyCellStyles(
  document: SheetDocument,
  worksheetId: string,
  writes: readonly SheetCellStyleWrite[],
): SheetDocument {
  if (writes.length === 0) return document;
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if (writes.length > SHEET_LIMITS.populatedCellsPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Formatting is limited to ${SHEET_LIMITS.populatedCellsPerWorksheet.toLocaleString()} cells at once.`,
    );
  }

  let styles = document.styles;
  const cells = { ...worksheet.cells };
  const resolved = new Map<string, SheetStyleId | undefined>();

  for (const { position, patch } of writes) {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) continue;
    const key = sheetCellKey(rowId, columnId);
    const cell = cells[key] ?? {};
    const merged = mergeStyle(styles[cell.styleId ?? ''], patch);
    const mergedKey = sheetStyleKey(merged);
    let styleId: SheetStyleId | undefined;
    if (resolved.has(mergedKey)) {
      styleId = resolved.get(mergedKey);
    } else {
      const result = styleIdFor(styles, merged);
      styles = result.styles;
      styleId = result.styleId;
      resolved.set(mergedKey, styleId);
    }
    const nextCell: SheetCell = { ...cell };
    if (styleId) nextCell.styleId = styleId;
    else delete nextCell.styleId;
    if (Object.keys(nextCell).length > 0) cells[key] = nextCell;
    else delete cells[key];
  }

  const worksheets = document.worksheets.map((candidate) =>
    candidate.id === worksheetId ? { ...candidate, cells } : candidate,
  );
  return pruneUnusedSheetStyles({ ...document, styles, worksheets });
}

export function applyStyleToSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  patch: Partial<SheetStyle>,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if (selection.kind === 'rows') {
    return applyTrackStyle(document, worksheet, selection, patch, 'row');
  }
  if (selection.kind === 'columns' || selection.kind === 'all') {
    return applyTrackStyle(document, worksheet, selection, patch, 'column');
  }

  const positions = selectedPositions(selection);
  if (positions.length > SHEET_LIMITS.populatedCellsPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Formatting is limited to ${SHEET_LIMITS.populatedCellsPerWorksheet.toLocaleString()} cells at once.`,
    );
  }

  let styles = document.styles;
  const cells = { ...worksheet.cells };
  for (const position of positions) {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) continue;
    const key = sheetCellKey(rowId, columnId);
    const cell = cells[key] ?? {};
    const current = styles[cell.styleId ?? ''];
    const result = styleIdFor(styles, mergeStyle(current, patch));
    styles = result.styles;
    const nextCell: SheetCell = { ...cell };
    if (result.styleId) nextCell.styleId = result.styleId;
    else delete nextCell.styleId;
    if (Object.keys(nextCell).length > 0) cells[key] = nextCell;
    else delete cells[key];
  }

  const worksheets = document.worksheets.map((candidate) =>
    candidate.id === worksheetId ? { ...candidate, cells } : candidate,
  );
  return pruneUnusedSheetStyles({ ...document, styles, worksheets });
}

export function clearStylesFromSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if (selection.kind === 'rows' || selection.kind === 'columns' || selection.kind === 'all') {
    const axis = selection.kind === 'rows' ? 'row' : 'column';
    const indexes = new Set<number>();
    for (const range of selection.ranges) {
      const rectangle = normalizeRange(range);
      const from = axis === 'row' ? rectangle.top : rectangle.left;
      const to = axis === 'row' ? rectangle.bottom : rectangle.right;
      for (let index = from; index <= to; index += 1) indexes.add(index);
    }
    const order = axis === 'row' ? worksheet.rowOrder : worksheet.columnOrder;
    const tracks: Record<string, SheetRow | SheetColumn> = {
      ...(axis === 'row' ? worksheet.rows : worksheet.columns),
    };
    for (const index of indexes) {
      const id = order[index];
      const track = id ? tracks[id] : undefined;
      if (!id || !track?.styleId) continue;
      const { styleId: _removed, ...rest } = track;
      tracks[id] = rest as SheetRow | SheetColumn;
    }
    const worksheets = document.worksheets.map((candidate) =>
      candidate.id !== worksheetId
        ? candidate
        : axis === 'row'
          ? { ...candidate, rows: tracks as SheetWorksheet['rows'] }
          : { ...candidate, columns: tracks as SheetWorksheet['columns'] },
    );
    return pruneUnusedSheetStyles({ ...document, worksheets });
  }

  const cells = { ...worksheet.cells };
  for (const position of selectedPositions(selection)) {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) continue;
    const key = sheetCellKey(rowId, columnId);
    const cell = cells[key];
    if (!cell?.styleId) continue;
    const { styleId: _removed, ...rest } = cell;
    if (Object.keys(rest).length > 0) cells[key] = rest;
    else delete cells[key];
  }
  const worksheets = document.worksheets.map((candidate) =>
    candidate.id === worksheetId ? { ...candidate, cells } : candidate,
  );
  return pruneUnusedSheetStyles({ ...document, worksheets });
}
