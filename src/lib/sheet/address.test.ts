import { describe, expect, it } from 'vitest';

import { columnIndex, columnLabel, formatA1, parseA1, SheetAddressIndex } from './address';
import { createWorksheetFixture } from './fixture';

describe('column labels', () => {
  it('round-trips across the boundary cases', () => {
    const cases: [number, string][] = [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [51, 'AZ'],
      [52, 'BA'],
      [701, 'ZZ'],
      [702, 'AAA'],
      [16_383, 'XFD'],
    ];
    for (const [index, label] of cases) {
      expect(columnLabel(index)).toBe(label);
      expect(columnIndex(label)).toBe(index);
    }
  });

  it('rejects invalid input instead of guessing', () => {
    expect(() => columnLabel(-1)).toThrow(RangeError);
    expect(columnIndex('A1')).toBeNull();
    expect(columnIndex('')).toBeNull();
    expect(parseA1('A0')).toBeNull();
    expect(parseA1('1A')).toBeNull();
  });

  it('parses absolute and mixed references', () => {
    expect(parseA1('A1')).toEqual({ row: 0, column: 0 });
    expect(parseA1('$B$12')).toEqual({ row: 11, column: 1 });
    expect(parseA1(' c3 ')).toEqual({ row: 2, column: 2 });
    expect(formatA1({ row: 11, column: 1 })).toBe('B12');
  });
});

describe('SheetAddressIndex', () => {
  const worksheet = createWorksheetFixture({
    rows: 10,
    columns: 5,
    populatedRows: 3,
    populatedColumns: 3,
  });

  it('maps stable identities to A1 positions', () => {
    const index = new SheetAddressIndex(worksheet);
    expect(index.a1For('r1', 'c1')).toBe('A1');
    expect(index.a1For('r3', 'c2')).toBe('B3');
    expect(index.cellKeyForA1('B3')).toBe('r3:c2');
    expect(
      index.a1ForRange({
        startRowId: 'r1',
        startColumnId: 'c1',
        endRowId: 'r3',
        endColumnId: 'c3',
      }),
    ).toBe('A1:C3');
  });

  it('normalizes reversed ranges', () => {
    const index = new SheetAddressIndex(worksheet);
    expect(
      index.a1ForRange({
        startRowId: 'r3',
        startColumnId: 'c3',
        endRowId: 'r1',
        endColumnId: 'c1',
      }),
    ).toBe('A1:C3');
  });

  it('reports dangling identities as null rather than inventing a position', () => {
    const index = new SheetAddressIndex(worksheet);
    expect(index.a1For('r1', 'missing')).toBeNull();
    expect(index.positionOf('missing', 'c1')).toBeNull();
    expect(index.cellKeyForA1('Z99')).toBeNull();
  });

  it('shifts A1 addresses when a row is inserted, without touching cell keys', () => {
    const before = new SheetAddressIndex(worksheet);
    expect(before.a1For('r3', 'c1')).toBe('A3');

    const withInsertedRow = {
      ...worksheet,
      rowOrder: ['r1', 'rNew', ...worksheet.rowOrder.slice(1)],
    };
    const after = new SheetAddressIndex(withInsertedRow);

    // The cell keeps its identity; only its derived A1 address moves.
    expect(after.a1For('r3', 'c1')).toBe('A4');
    expect(worksheet.cells['r3:c1']).toBeDefined();
  });
});
