import { describe, expect, it } from 'vitest';

import { addWorksheet, createEmptySheetDocument } from './document';
import {
  createSheetNamedRange,
  expandNamedRangesInFormula,
  namedRangeSelection,
  removeSheetNamedRange,
  resolveNamedRange,
} from './namedRanges';
import { activeWorksheet, deleteTracks, duplicateWorksheet, setCell } from './operations';
import { createSelection, extendSelection } from './selection';
import { buildSheetFormulaRequest } from './useSheetFormulaEngine';

function fixture() {
  return createEmptySheetDocument('Names', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { name: 'Data Sheet', rows: 8, columns: 5 },
  });
}

describe('sheet named ranges', () => {
  it('creates stable workbook and worksheet-scoped names with conflict checks', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    const selection = extendSelection(createSelection({ row: 1, column: 0 }), {
      row: 3,
      column: 1,
    });
    document = createSheetNamedRange(document, worksheet.id, selection, 'Revenue', 'workbook');
    expect(document.namedRanges?.[0]).toMatchObject({
      name: 'Revenue',
      worksheetId: worksheet.id,
    });
    expect(document.namedRanges?.[0].scopeWorksheetId).toBeUndefined();
    expect(() =>
      createSheetNamedRange(document, worksheet.id, selection, 'Revenue', 'worksheet'),
    ).toThrowError(/already visible/);
    expect(() =>
      createSheetNamedRange(document, worksheet.id, selection, 'A1', 'workbook'),
    ).toThrowError(/cannot look like a cell address/);

    document = removeSheetNamedRange(document, document.namedRanges![0].id);
    expect(document.namedRanges).toBeUndefined();
  });

  it('expands visible names only at the formula-engine boundary', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = createSheetNamedRange(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 1, column: 0 }), { row: 3, column: 0 }),
      'Revenue',
      'workbook',
    );
    const formula = '=SUM(Revenue)+LEN("Revenue")';
    expect(expandNamedRangesInFormula(document, worksheet.id, formula)).toBe(
      '=SUM($A$2:$A$4)+LEN("Revenue")',
    );

    document = setCell(document, worksheet.id, { row: 0, column: 0 }, { formula });
    const request = buildSheetFormulaRequest(document, 'runtime', 'UTC');
    expect(request.cells[0].formula).toBe('=SUM($A$2:$A$4)+LEN("Revenue")');
    expect(
      document.worksheets[0].cells[`${worksheet.rowOrder[0]}:${worksheet.columnOrder[0]}`].formula,
    ).toBe(formula);
  });

  it('does not expand names inside strings or explicit worksheet qualifiers', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = createSheetNamedRange(
      document,
      worksheet.id,
      createSelection({ row: 0, column: 0 }),
      'Data',
      'workbook',
    );
    expect(
      expandNamedRangesInFormula(document, worksheet.id, '=Data+"Data"+Data!A1+\'Data Sheet\'!A1'),
    ).toBe('=$A$1+"Data"+Data!A1+\'Data Sheet\'!A1');
  });

  it('resolves cross-sheet names and converts them to selections', () => {
    let document = fixture();
    const data = activeWorksheet(document);
    document = createSheetNamedRange(
      document,
      data.id,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
      'Inputs',
      'workbook',
    );
    document = addWorksheet(document, 'Summary');
    const summary = activeWorksheet(document);
    expect(expandNamedRangesInFormula(document, summary.id, '=SUM(Inputs)')).toBe(
      "=SUM('Data Sheet'!$A$1:$B$2)",
    );
    const resolved = resolveNamedRange(document, summary.id, 'inputs');
    expect(resolved?.worksheet.id).toBe(data.id);
    expect(namedRangeSelection(resolved!)?.ranges[0].focus).toEqual({ row: 1, column: 1 });
  });

  it('shrinks names after deletion and duplicates worksheet-local names', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    document = createSheetNamedRange(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 1, column: 0 }), { row: 3, column: 0 }),
      'LocalValues',
      'worksheet',
    );
    const original = document.namedRanges![0];
    const nextStart = worksheet.rowOrder[2];
    document = deleteTracks(document, worksheet.id, 'row', 1, 1);
    expect(document.namedRanges?.[0].range.startRowId).toBe(nextStart);

    worksheet = activeWorksheet(document);
    document = duplicateWorksheet(document, worksheet.id);
    const copy = activeWorksheet(document);
    const copiedName = document.namedRanges?.find((range) => range.scopeWorksheetId === copy.id);
    expect(copiedName?.id).not.toBe(original.id);
    expect(copiedName?.worksheetId).toBe(copy.id);
    expect(copiedName?.range.startRowId).toBe(copy.rowOrder[1]);
  });
});
