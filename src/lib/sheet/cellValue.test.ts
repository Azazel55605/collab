import { describe, expect, it } from 'vitest';

import {
  cellAlignment,
  formatCellDisplay,
  formatCellEditText,
  formatNumberWithStyle,
  formatNumber,
  numericValueOf,
  parseCellInput,
} from './cellValue';

describe('parseCellInput', () => {
  it('treats empty input as a cleared cell', () => {
    expect(parseCellInput('')).toBeNull();
    expect(parseCellInput('   ')).toBeNull();
  });

  it('stores formula source verbatim', () => {
    expect(parseCellInput('=SUM(A1:A5)')).toEqual({ formula: '=SUM(A1:A5)' });
    expect(parseCellInput('  =A1 + B1  ')).toEqual({ formula: '=A1 + B1' });
  });

  it('recognizes numbers, including separators, signs, and exponents', () => {
    expect(parseCellInput('42')).toEqual({ value: 42, valueType: 'number' });
    expect(parseCellInput('-3.5')).toEqual({ value: -3.5, valueType: 'number' });
    expect(parseCellInput('1,234.5')).toEqual({ value: 1234.5, valueType: 'number' });
    expect(parseCellInput('1e3')).toEqual({ value: 1000, valueType: 'number' });
    expect(parseCellInput('25%')).toEqual({ value: 0.25, valueType: 'number' });
  });

  it('recognizes booleans case-insensitively', () => {
    expect(parseCellInput('true')).toEqual({ value: true, valueType: 'boolean' });
    expect(parseCellInput('FALSE')).toEqual({ value: false, valueType: 'boolean' });
  });

  it('stores dates and times as ISO strings, never serials', () => {
    expect(parseCellInput('2026-07-29')).toEqual({ value: '2026-07-29', valueType: 'date' });
    expect(parseCellInput('9:05')).toEqual({ value: '09:05:00', valueType: 'time' });
    expect(parseCellInput('14:30:15')).toEqual({ value: '14:30:15', valueType: 'time' });
    expect(parseCellInput('2026-07-29T14:30')).toEqual({
      value: '2026-07-29T14:30:00',
      valueType: 'datetime',
    });
  });

  it('rejects impossible dates and times rather than coercing them', () => {
    expect(parseCellInput('2026-02-30')).toEqual({ value: '2026-02-30', valueType: 'text' });
    expect(parseCellInput('25:00')).toEqual({ value: '25:00', valueType: 'text' });
  });

  it('falls back to text for anything not confidently recognized', () => {
    expect(parseCellInput('hello')).toEqual({ value: 'hello', valueType: 'text' });
    expect(parseCellInput('1-2-3')).toEqual({ value: '1-2-3', valueType: 'text' });
    expect(parseCellInput('+')).toEqual({ value: '+', valueType: 'text' });
    // Leading zeros parse as numbers, matching every spreadsheet: a user who
    // needs "007" preserved formats the cell as text (Phase 4).
    expect(parseCellInput('007')).toEqual({ value: 7, valueType: 'number' });
  });
});

describe('formatting', () => {
  it('renders values for display', () => {
    expect(formatCellDisplay(undefined)).toBe('');
    expect(formatCellDisplay({ value: 42, valueType: 'number' })).toBe('42');
    expect(formatCellDisplay({ value: true, valueType: 'boolean' })).toBe('TRUE');
    expect(formatCellDisplay({ value: 'text', valueType: 'text' })).toBe('text');
    expect(formatCellDisplay({ value: '2026-07-29', valueType: 'date' })).toBe('2026-07-29');
    expect(formatCellDisplay({ formula: '=A1' })).toBe('…');
  });

  it('applies number formats without changing the numeric value', () => {
    expect(formatNumberWithStyle(0.125, { kind: 'percent', decimals: 1 }, { locale: 'en-US' }))
      .toBe('12.5%');
    expect(formatNumberWithStyle(1234.5, {
      kind: 'currency',
      currencyCode: 'EUR',
      decimals: 2,
    }, { locale: 'en-US' })).toBe('€1,234.50');
    expect(formatNumberWithStyle(1234.5, {
      kind: 'custom',
      pattern: 'Value: #,##0.00',
    }, { locale: 'en-US' })).toBe('Value: 1,234.50');
  });

  it('renders edit text that round-trips through parseCellInput', () => {
    for (const input of ['42', 'TRUE', '2026-07-29', 'hello', '=SUM(A1:A2)']) {
      const cell = parseCellInput(input)!;
      expect(formatCellEditText(cell)).toBe(input);
    }
  });

  it('avoids binary floating point noise', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.333333333333');
    expect(formatNumber(1e21)).toBe('1e+21');
  });

  it('aligns by type', () => {
    expect(cellAlignment({ value: 1, valueType: 'number' })).toBe('right');
    expect(cellAlignment({ value: '2026-07-29', valueType: 'date' })).toBe('right');
    expect(cellAlignment({ value: true, valueType: 'boolean' })).toBe('center');
    expect(cellAlignment({ value: 'x', valueType: 'text' })).toBe('left');
    expect(cellAlignment(undefined)).toBe('left');
  });

  it('exposes numeric values for summaries but not formulas', () => {
    expect(numericValueOf({ value: 5, valueType: 'number' })).toBe(5);
    expect(numericValueOf({ value: 'x', valueType: 'text' })).toBeNull();
    expect(numericValueOf({ formula: '=1+1' })).toBeNull();
  });
});
