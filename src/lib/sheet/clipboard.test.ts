import { describe, expect, it } from 'vitest';

import { sheetFormulaResultKey } from '../../types/sheetFormula';
import { createEmptySheetDocument } from './document';
import { activeWorksheet, getCell, setCell } from './operations';
import { createSelection, extendSelection } from './selection';
import { applyStyleToSelection, resolveCellStyle } from './styles';
import {
  createSheetClipboardPayload,
  parseSheetClipboardPayload,
  pasteSheetClipboardPayload,
  sheetClipboardToHtml,
  sheetClipboardToTsv,
  tsvToSheetClipboard,
} from './clipboard';

function workbook() {
  return createEmptySheetDocument('Clipboard fixture', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 8, columns: 8 },
  });
}

describe('sheet clipboard', () => {
  it('copies structured cells and translates relative formulas at the destination', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 0, column: 0 }, { value: 4, valueType: 'number' });
    document = setCell(document, worksheet.id, { row: 0, column: 1 }, { formula: '=A1*2' });
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 0, column: 1 });
    document = applyStyleToSelection(document, worksheet.id, selection, { bold: true });

    const payload = createSheetClipboardPayload(document, activeWorksheet(document), selection);
    const pasted = pasteSheetClipboardPayload(document, worksheet.id, { row: 2, column: 2 }, payload);
    const target = activeWorksheet(pasted);

    expect(getCell(target, { row: 2, column: 2 })).toMatchObject({ value: 4, valueType: 'number' });
    expect(getCell(target, { row: 2, column: 3 })?.formula).toBe('=C3*2');
    expect(resolveCellStyle(pasted.styles, target, { row: 2, column: 2 })).toMatchObject({ bold: true });
  });

  it('pastes computed formula results as values and leaves literals untouched in formula-only mode', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 0, column: 0 }, { formula: '=2+3' });
    document = setCell(document, worksheet.id, { row: 0, column: 1 }, { value: 'literal', valueType: 'text' });
    document = setCell(document, worksheet.id, { row: 3, column: 4 }, { value: 'keep', valueType: 'text' });
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 0, column: 1 });
    const values = new Map([
      [sheetFormulaResultKey(worksheet.id, worksheet.rowOrder[0], worksheet.columnOrder[0]), { type: 'number' as const, value: 5 }],
    ]);
    const payload = createSheetClipboardPayload(document, activeWorksheet(document), selection, values);

    const valuesPaste = pasteSheetClipboardPayload(document, worksheet.id, { row: 2, column: 2 }, payload, 'values');
    expect(getCell(activeWorksheet(valuesPaste), { row: 2, column: 2 })).toEqual({ value: 5, valueType: 'number' });

    const formulasPaste = pasteSheetClipboardPayload(document, worksheet.id, { row: 3, column: 3 }, payload, 'formulas');
    expect(getCell(activeWorksheet(formulasPaste), { row: 3, column: 3 })?.formula).toBe('=2+3');
    expect(getCell(activeWorksheet(formulasPaste), { row: 3, column: 4 })).toEqual({
      value: 'keep',
      valueType: 'text',
    });
  });

  it('parses quoted TSV through the normal typed cell-input rules', () => {
    const payload = tsvToSheetClipboard('12\t=SUM(A1:A2)\n"line 1\nline 2"\tTRUE');

    expect(payload).toMatchObject({ rows: 2, columns: 2 });
    expect(payload.cells[0][0]?.cell).toEqual({ value: 12, valueType: 'number' });
    expect(payload.cells[0][1]?.cell).toEqual({ formula: '=SUM(A1:A2)' });
    expect(payload.cells[1][0]?.cell).toEqual({ value: 'line 1\nline 2', valueType: 'text' });
    expect(payload.cells[1][1]?.cell).toEqual({ value: true, valueType: 'boolean' });
    expect(sheetClipboardToTsv(payload)).toBe('12\t=SUM(A1:A2)\n"line 1\nline 2"\tTRUE');
  });

  it('escapes HTML fallback content and rejects malformed private payloads', () => {
    const payload = tsvToSheetClipboard('<script>alert("x")</script>');
    const html = sheetClipboardToHtml(payload);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(parseSheetClipboardPayload(JSON.stringify(payload))).toEqual(payload);
    expect(parseSheetClipboardPayload(JSON.stringify({ ...payload, rows: 2 }))).toBeNull();
    expect(parseSheetClipboardPayload(JSON.stringify({ ...payload, columns: 100_001 }))).toBeNull();
  });
});
