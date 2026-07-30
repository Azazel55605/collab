import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { activeWorksheet, getCell, setCell } from './operations';
import {
  findSheetMatches,
  nextSheetMatch,
  replaceAllSheetMatches,
  replaceSheetMatch,
} from './search';

function fixture() {
  let document = createEmptySheetDocument('Search', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 5, columns: 4 },
  });
  const worksheet = activeWorksheet(document);
  document = setCell(document, worksheet.id, { row: 0, column: 0 }, { value: 'Alpha beta', valueType: 'text' });
  document = setCell(document, worksheet.id, { row: 1, column: 0 }, { value: 'BETA', valueType: 'text' });
  document = setCell(document, worksheet.id, { row: 2, column: 0 }, { formula: '=SUM(BETA)' });
  return document;
}

describe('sheet search', () => {
  it('finds in row order and wraps navigation', () => {
    const worksheet = activeWorksheet(fixture());
    const matches = findSheetMatches(worksheet, 'beta');
    expect(matches).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 2, column: 0 },
    ]);
    expect(nextSheetMatch(matches, { row: 2, column: 0 })).toEqual({ row: 0, column: 0 });
    expect(nextSheetMatch(matches, { row: 0, column: 0 }, 'previous')).toEqual({ row: 2, column: 0 });
  });

  it('supports case and whole-cell matching', () => {
    const worksheet = activeWorksheet(fixture());
    expect(findSheetMatches(worksheet, 'BETA', { matchCase: true })).toHaveLength(2);
    expect(findSheetMatches(worksheet, 'beta', { wholeCell: true })).toHaveLength(1);
  });

  it('replaces one or all matches while preserving formulas and typed values', () => {
    const document = fixture();
    const worksheet = activeWorksheet(document);
    const one = replaceSheetMatch(document, worksheet.id, { row: 2, column: 0 }, 'beta', 'A1');
    expect(getCell(activeWorksheet(one), { row: 2, column: 0 })?.formula).toBe('=SUM(A1)');

    const all = replaceAllSheetMatches(document, worksheet.id, 'beta', '42');
    expect(all.count).toBe(3);
    expect(getCell(activeWorksheet(all.document), { row: 1, column: 0 })).toEqual({
      value: 42,
      valueType: 'number',
    });
  });
});
