import { SHEET_LIMITS } from '../../types/sheet';
import type {
  SheetDocument,
  SheetNamedRange,
  SheetRange,
  SheetWorksheet,
} from '../../types/sheet';
import { columnLabel } from './address';
import { createSheetNamedRangeId, SheetDocumentError } from './document';
import type { SheetSelection } from './selection';
import { stableRangeFromSelection } from './validation';

export const SHEET_NAMED_RANGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
export const SHEET_CELL_REFERENCE_PATTERN = /^[A-Za-z]{1,3}[1-9]\d*$/;

export type SheetNamedRangeScope = 'workbook' | 'worksheet';

export interface ResolvedNamedRange {
  namedRange: SheetNamedRange;
  worksheet: SheetWorksheet;
  range: SheetRange;
}

export function visibleNamedRanges(
  document: SheetDocument,
  sourceWorksheetId: string,
): SheetNamedRange[] {
  return (document.namedRanges ?? []).filter((range) => (
    range.scopeWorksheetId === undefined || range.scopeWorksheetId === sourceWorksheetId
  ));
}

export function resolveNamedRange(
  document: SheetDocument,
  sourceWorksheetId: string,
  name: string,
): ResolvedNamedRange | null {
  const normalized = name.trim().toLocaleLowerCase();
  const visible = visibleNamedRanges(document, sourceWorksheetId);
  const namedRange = visible.find((range) => (
    range.scopeWorksheetId === sourceWorksheetId
    && range.name.toLocaleLowerCase() === normalized
  )) ?? visible.find((range) => (
    range.scopeWorksheetId === undefined
    && range.name.toLocaleLowerCase() === normalized
  ));
  if (!namedRange) return null;
  const worksheet = document.worksheets.find(
    (candidate) => candidate.id === namedRange.worksheetId,
  );
  return worksheet ? { namedRange, worksheet, range: namedRange.range } : null;
}

export function createSheetNamedRange(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  name: string,
  scope: SheetNamedRangeScope,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if ((document.namedRanges?.length ?? 0) >= SHEET_LIMITS.namedRangesPerWorkbook) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A workbook may not have more than ${SHEET_LIMITS.namedRangesPerWorkbook} named ranges.`,
    );
  }
  const trimmed = name.trim();
  if (
    !SHEET_NAMED_RANGE_PATTERN.test(trimmed)
    || SHEET_CELL_REFERENCE_PATTERN.test(trimmed)
  ) {
    throw new SheetDocumentError(
      'invalid-structure',
      'Names must start with a letter or underscore, contain only letters, numbers, dots, or underscores, and cannot look like a cell address.',
    );
  }
  const scopeWorksheetId = scope === 'worksheet' ? worksheetId : undefined;
  const conflict = (document.namedRanges ?? []).some((range) => (
    range.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
    && (
      range.scopeWorksheetId === undefined
      || scopeWorksheetId === undefined
      || range.scopeWorksheetId === scopeWorksheetId
    )
  ));
  if (conflict) {
    throw new SheetDocumentError('invalid-structure', `The name "${trimmed}" is already visible in this scope.`);
  }
  const range = stableRangeFromSelection(worksheet, {
    ...selection,
    ranges: selection.ranges.slice(0, 1),
  });
  if (!range) return document;
  const namedRange: SheetNamedRange = {
    id: createSheetNamedRangeId(),
    name: trimmed,
    worksheetId,
    range,
    scopeWorksheetId,
  };
  return { ...document, namedRanges: [...(document.namedRanges ?? []), namedRange] };
}

export function removeSheetNamedRange(
  document: SheetDocument,
  namedRangeId: string,
): SheetDocument {
  const namedRanges = (document.namedRanges ?? []).filter((range) => range.id !== namedRangeId);
  if (namedRanges.length === (document.namedRanges?.length ?? 0)) return document;
  const next = { ...document };
  if (namedRanges.length > 0) next.namedRanges = namedRanges;
  else delete next.namedRanges;
  return next;
}

function sheetPrefix(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)
    ? `${name}!`
    : `'${name.replace(/'/g, "''")}'!`;
}

function absoluteRangeText(
  worksheet: SheetWorksheet,
  range: SheetRange,
): string | null {
  const startRow = worksheet.rowOrder.indexOf(range.startRowId);
  const endRow = worksheet.rowOrder.indexOf(range.endRowId);
  const startColumn = worksheet.columnOrder.indexOf(range.startColumnId);
  const endColumn = worksheet.columnOrder.indexOf(range.endColumnId);
  if (startRow < 0 || endRow < 0 || startColumn < 0 || endColumn < 0) return null;
  const first = `$${columnLabel(startColumn)}$${startRow + 1}`;
  const last = `$${columnLabel(endColumn)}$${endRow + 1}`;
  return first === last ? first : `${first}:${last}`;
}

export function expandNamedRangesInFormula(
  document: SheetDocument,
  sourceWorksheetId: string,
  formula: string,
): string {
  if (!formula.startsWith('=') || !document.namedRanges?.length) return formula;
  let output = '';
  let index = 0;
  let stringQuoted = false;
  let sheetQuoted = false;
  while (index < formula.length) {
    const character = formula[index];
    if (!sheetQuoted && character === '"') {
      if (stringQuoted && formula[index + 1] === '"') {
        output += '""';
        index += 2;
        continue;
      }
      stringQuoted = !stringQuoted;
      output += character;
      index += 1;
      continue;
    }
    if (!stringQuoted && character === "'") {
      if (sheetQuoted && formula[index + 1] === "'") {
        output += "''";
        index += 2;
        continue;
      }
      sheetQuoted = !sheetQuoted;
      output += character;
      index += 1;
      continue;
    }
    const match = !stringQuoted && !sheetQuoted && /[A-Za-z_]/.test(character)
      ? /^[A-Za-z_][A-Za-z0-9_.]*/.exec(formula.slice(index))
      : null;
    if (!match) {
      output += character;
      index += 1;
      continue;
    }
    const token = match[0];
    const after = formula[index + token.length];
    const resolved = after === '(' || after === '!'
      ? null
      : resolveNamedRange(document, sourceWorksheetId, token);
    if (!resolved) {
      output += token;
      index += token.length;
      continue;
    }
    const rangeText = absoluteRangeText(resolved.worksheet, resolved.range);
    if (!rangeText) {
      output += '#REF!';
    } else {
      output += resolved.worksheet.id === sourceWorksheetId
        ? rangeText
        : `${sheetPrefix(resolved.worksheet.name)}${rangeText}`;
    }
    index += token.length;
  }
  return output;
}

export function namedRangeSelection(
  resolved: ResolvedNamedRange,
): SheetSelection | null {
  const startRow = resolved.worksheet.rowOrder.indexOf(resolved.range.startRowId);
  const endRow = resolved.worksheet.rowOrder.indexOf(resolved.range.endRowId);
  const startColumn = resolved.worksheet.columnOrder.indexOf(resolved.range.startColumnId);
  const endColumn = resolved.worksheet.columnOrder.indexOf(resolved.range.endColumnId);
  if (startRow < 0 || endRow < 0 || startColumn < 0 || endColumn < 0) return null;
  const start = { row: startRow, column: startColumn };
  const end = { row: endRow, column: endColumn };
  return { ranges: [{ anchor: start, focus: end }], active: start, kind: 'cells' };
}
