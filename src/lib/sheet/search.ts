import { parseSheetCellKey } from '../../types/sheet';
import type { SheetDocument, SheetWorksheet } from '../../types/sheet';

import { sheetAddressIndex, type SheetPosition } from './address';
import { formatCellEditText, parseCellInput } from './cellValue';
import { getCell, setCell, setCells } from './operations';

export interface SheetSearchOptions {
  matchCase?: boolean;
  wholeCell?: boolean;
}

function normalized(value: string, matchCase: boolean): string {
  return matchCase ? value : value.toLocaleLowerCase();
}

function matchesText(value: string, query: string, options: SheetSearchOptions): boolean {
  const haystack = normalized(value, Boolean(options.matchCase));
  const needle = normalized(query, Boolean(options.matchCase));
  return options.wholeCell ? haystack === needle : haystack.includes(needle);
}

export function findSheetMatches(
  worksheet: SheetWorksheet,
  query: string,
  options: SheetSearchOptions = {},
): SheetPosition[] {
  return findPopulatedSheetMatches(worksheet, query, options);
}

/**
 * The same matches as {@link findSheetMatches}, found by scanning the sparse
 * cell map instead of every logical position. Cost is bounded by the number of
 * populated cells rather than `rows * columns`, which is what makes search
 * viable on a phone against a tall worksheet. Results keep row-major order so
 * both scans navigate identically.
 */
export function findPopulatedSheetMatches(
  worksheet: SheetWorksheet,
  query: string,
  options: SheetSearchOptions = {},
): SheetPosition[] {
  if (!query) return [];
  const index = sheetAddressIndex(worksheet);
  const matches: SheetPosition[] = [];
  for (const [key, cell] of Object.entries(worksheet.cells)) {
    const parsed = parseSheetCellKey(key);
    if (!parsed) continue;
    const row = index.rowIndexOf(parsed.rowId);
    const column = index.columnIndexOf(parsed.columnId);
    if (row === null || column === null) continue;
    const text = formatCellEditText(cell);
    if (text && matchesText(text, query, options)) matches.push({ row, column });
  }
  matches.sort((a, b) => a.row - b.row || a.column - b.column);
  return matches;
}

export function nextSheetMatch(
  matches: readonly SheetPosition[],
  active: SheetPosition,
  direction: 'next' | 'previous' = 'next',
): SheetPosition | null {
  if (matches.length === 0) return null;
  const current = matches.findIndex(
    (position) => position.row === active.row && position.column === active.column,
  );
  if (direction === 'previous') {
    return matches[current > 0 ? current - 1 : matches.length - 1];
  }
  return matches[current >= 0 && current < matches.length - 1 ? current + 1 : 0];
}

function replaceText(
  value: string,
  query: string,
  replacement: string,
  options: SheetSearchOptions,
): string {
  if (options.wholeCell) return replacement;
  if (options.matchCase) return value.split(query).join(replacement);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'giu'), replacement);
}

export function replaceSheetMatch(
  document: SheetDocument,
  worksheetId: string,
  position: SheetPosition,
  query: string,
  replacement: string,
  options: SheetSearchOptions = {},
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet || !query) return document;
  const cell = getCell(worksheet, position);
  const text = formatCellEditText(cell);
  if (!cell || !matchesText(text, query, options)) return document;
  return setCell(
    document,
    worksheetId,
    position,
    parseCellInput(replaceText(text, query, replacement, options)),
  );
}

export function replaceAllSheetMatches(
  document: SheetDocument,
  worksheetId: string,
  query: string,
  replacement: string,
  options: SheetSearchOptions = {},
): { document: SheetDocument; count: number } {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet || !query) return { document, count: 0 };
  const matches = findSheetMatches(worksheet, query, options);
  const updates = matches.map((position) => ({
    position,
    cell: parseCellInput(
      replaceText(formatCellEditText(getCell(worksheet, position)), query, replacement, options),
    ),
  }));
  return { document: setCells(document, worksheetId, updates), count: matches.length };
}
