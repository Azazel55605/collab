import { SHEET_LIMITS } from '../../types/sheet';
import type { SheetCell, SheetDocument, SheetStyle, SheetWorksheet } from '../../types/sheet';
import type { SheetFormulaComputedValue, SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import type { SheetPosition } from './address';
import { formatCellEditText, parseCellInput } from './cellValue';
import { SheetDocumentError } from './document';
import { translateFormulaReferences } from './formulaReferences';
import { getCell, setCells, type SheetCellWrite } from './operations';
import { normalizeRange, type SheetSelection } from './selection';
import { applyCellStyles, resolveCellStyle, type SheetCellStyleWrite } from './styles';

export const SHEET_CLIPBOARD_MIME = 'application/vnd.collab.sheet-selection+json';
export const SHEET_CLIPBOARD_VERSION = 1;
const MAX_CLIPBOARD_CELLS = 100_000;

export interface SheetClipboardCell {
  cell?: SheetCell;
  style?: SheetStyle;
  computed?: SheetFormulaComputedValue;
}

export interface SheetClipboardPayload {
  kind: 'collab-sheet-selection';
  version: typeof SHEET_CLIPBOARD_VERSION;
  rows: number;
  columns: number;
  sourceTop: number;
  sourceLeft: number;
  cells: Array<Array<SheetClipboardCell | null>>;
}

export type SheetPasteMode = 'all' | 'values' | 'formulas' | 'formatting';

export function createSheetClipboardPayload(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  computedValues?: SheetFormulaValueMap,
): SheetClipboardPayload {
  const range = selection.ranges[selection.ranges.length - 1];
  const rectangle = normalizeRange(range);
  const rows = rectangle.bottom - rectangle.top + 1;
  const columns = rectangle.right - rectangle.left + 1;
  if (rows * columns > MAX_CLIPBOARD_CELLS) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `Copy is limited to ${MAX_CLIPBOARD_CELLS.toLocaleString()} cells at once.`,
    );
  }

  const cells = Array.from({ length: rows }, (_, rowOffset) => (
    Array.from({ length: columns }, (_, columnOffset): SheetClipboardCell | null => {
      const position = {
        row: rectangle.top + rowOffset,
        column: rectangle.left + columnOffset,
      };
      const cell = getCell(worksheet, position);
      const style = resolveCellStyle(document.styles, worksheet, position);
      const rowId = worksheet.rowOrder[position.row];
      const columnId = worksheet.columnOrder[position.column];
      const computed = rowId && columnId
        ? computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
        : undefined;
      if (!cell && Object.keys(style).length === 0) return null;
      return {
        // Validation belongs to the destination cell, not copied content.
        cell: cell ? { ...cell, styleId: undefined, validationId: undefined } : undefined,
        style: Object.keys(style).length > 0 ? style : undefined,
        computed,
      };
    })
  ));
  return {
    kind: 'collab-sheet-selection',
    version: SHEET_CLIPBOARD_VERSION,
    rows,
    columns,
    sourceTop: rectangle.top,
    sourceLeft: rectangle.left,
    cells,
  };
}

function computedToCell(computed: SheetFormulaComputedValue | undefined): SheetCell | null {
  if (!computed || computed.type === 'blank' || computed.type === 'error') return null;
  if (computed.type === 'number') return { value: computed.value, valueType: 'number' };
  if (computed.type === 'boolean') return { value: computed.value, valueType: 'boolean' };
  return { value: computed.value, valueType: 'text' };
}

export function pasteSheetClipboardPayload(
  document: SheetDocument,
  worksheetId: string,
  target: SheetPosition,
  payload: SheetClipboardPayload,
  mode: SheetPasteMode = 'all',
): SheetDocument {
  if (payload.kind !== 'collab-sheet-selection' || payload.version !== SHEET_CLIPBOARD_VERSION) {
    throw new SheetDocumentError('invalid-structure', 'The clipboard data is not a supported Collab table selection.');
  }
  if (payload.rows * payload.columns > MAX_CLIPBOARD_CELLS) {
    throw new SheetDocumentError('limit-exceeded', 'The clipboard selection is too large.');
  }
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  // Collected and applied in two batched passes. Writing each pasted cell (and
  // its style) individually would copy the whole sparse map per cell.
  const cellWrites: SheetCellWrite[] = [];
  const styleWrites: SheetCellStyleWrite[] = [];
  for (let rowOffset = 0; rowOffset < payload.rows; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < payload.columns; columnOffset += 1) {
      const destination = { row: target.row + rowOffset, column: target.column + columnOffset };
      if (!worksheet.rowOrder[destination.row] || !worksheet.columnOrder[destination.column]) continue;
      const entry = payload.cells[rowOffset]?.[columnOffset] ?? null;
      const sourceCell = entry?.cell;

      if (mode !== 'formatting') {
        let pasted: SheetCell | null = null;
        if (mode === 'values') {
          pasted = sourceCell?.formula
            ? computedToCell(entry?.computed)
            : sourceCell
              ? { value: sourceCell.value, valueType: sourceCell.valueType }
              : null;
        } else if (mode === 'formulas') {
          if (!sourceCell?.formula) continue;
          pasted = { formula: translateFormulaReferences(
            sourceCell.formula,
            destination.row - (payload.sourceTop + rowOffset),
            destination.column - (payload.sourceLeft + columnOffset),
          ) };
        } else if (sourceCell) {
          pasted = { ...sourceCell };
          if (pasted.formula) {
            pasted.formula = translateFormulaReferences(
              pasted.formula,
              destination.row - (payload.sourceTop + rowOffset),
              destination.column - (payload.sourceLeft + columnOffset),
            );
          }
        }
        cellWrites.push({ position: destination, cell: pasted });
      }

      if ((mode === 'all' || mode === 'formatting') && entry?.style) {
        styleWrites.push({ position: destination, patch: entry.style });
      }
    }
  }
  return applyCellStyles(
    setCells(document, worksheetId, cellWrites),
    worksheetId,
    styleWrites,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clipboardText(entry: SheetClipboardCell | null): string {
  if (!entry?.cell) return '';
  return formatCellEditText(entry.cell);
}

export function sheetClipboardToTsv(payload: SheetClipboardPayload): string {
  return payload.cells.map((row) => row.map((entry) => {
    const value = clipboardText(entry);
    return /[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join('\t')).join('\n');
}

export function sheetClipboardToHtml(payload: SheetClipboardPayload): string {
  const rows = payload.cells.map((row) => `<tr>${row.map((entry) => (
    `<td>${escapeHtml(clipboardText(entry)).replace(/\n/g, '<br>')}</td>`
  )).join('')}</tr>`).join('');
  return `<table>${rows}</table>`;
}

export function parseSheetClipboardPayload(value: string): SheetClipboardPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<SheetClipboardPayload>;
    if (parsed.kind !== 'collab-sheet-selection' || parsed.version !== SHEET_CLIPBOARD_VERSION
      || !Number.isInteger(parsed.rows) || !Number.isInteger(parsed.columns)
      || !Number.isInteger(parsed.sourceTop) || !Number.isInteger(parsed.sourceLeft)
      || (parsed.rows ?? 0) < 1 || (parsed.columns ?? 0) < 1
      || (parsed.rows ?? 0) * (parsed.columns ?? 0) > MAX_CLIPBOARD_CELLS
      || (parsed.sourceTop ?? -1) < 0 || (parsed.sourceLeft ?? -1) < 0
      || !Array.isArray(parsed.cells) || parsed.cells.length !== parsed.rows
      || parsed.cells.some((row) => !Array.isArray(row) || row.length !== parsed.columns)) return null;
    return parsed as SheetClipboardPayload;
  } catch {
    return null;
  }
}

export function tsvToSheetClipboard(value: string): SheetClipboardPayload {
  const rows: string[][] = [[]];
  let field = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === '\t') {
      rows[rows.length - 1].push(field);
      field = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      rows[rows.length - 1].push(field);
      field = '';
      rows.push([]);
    } else {
      field += character;
    }
  }
  rows[rows.length - 1].push(field);
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  const columns = Math.max(1, ...rows.map((row) => row.length));
  if (rows.length * columns > MAX_CLIPBOARD_CELLS || rows.length > SHEET_LIMITS.rowsPerWorksheet) {
    throw new SheetDocumentError('limit-exceeded', 'The clipboard selection is too large.');
  }
  return {
    kind: 'collab-sheet-selection',
    version: SHEET_CLIPBOARD_VERSION,
    rows: rows.length,
    columns,
    sourceTop: 0,
    sourceLeft: 0,
    cells: rows.map((row) => Array.from({ length: columns }, (_, index) => (
      row[index] === undefined || row[index] === ''
        ? null
        : { cell: parseCellInput(row[index]) ?? undefined }
    ))),
  };
}
