import type { SheetDocument, SheetWorksheet } from '../../types/sheet';
import type { SheetPosition } from './address';
import { formatCellEditText, parseCellInput } from './cellValue';
import { getCell, setCell } from './operations';

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
  if (!query) return [];
  const matches: SheetPosition[] = [];
  for (let row = 0; row < worksheet.rowOrder.length; row += 1) {
    for (let column = 0; column < worksheet.columnOrder.length; column += 1) {
      const text = formatCellEditText(getCell(worksheet, { row, column }));
      if (text && matchesText(text, query, options)) matches.push({ row, column });
    }
  }
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
  let next = document;
  for (const position of matches) {
    next = replaceSheetMatch(next, worksheetId, position, query, replacement, options);
  }
  return { document: next, count: matches.length };
}
