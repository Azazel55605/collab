import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { fillSheetSelection } from './fill';
import { activeWorksheet, getCell, setCell } from './operations';
import { createSelection, extendSelection } from './selection';
import { applyStyleToSelection, resolveCellStyle } from './styles';

function workbook() {
  return createEmptySheetDocument('Fill fixture', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 12, columns: 8 },
  });
}

describe('sheet fill', () => {
  it('continues numeric series and expands the selection', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 0 },
      { value: 2, valueType: 'number' },
    );
    document = setCell(
      document,
      worksheet.id,
      { row: 1, column: 0 },
      { value: 4, valueType: 'number' },
    );
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), {
      row: 1,
      column: 0,
    });

    const result = fillSheetSelection(document, worksheet.id, selection, { row: 4, column: 0 });

    expect(getCell(activeWorksheet(result.document), { row: 4, column: 0 })?.value).toBe(10);
    expect(result.selection.ranges[0].focus).toEqual({ row: 4, column: 0 });
  });

  it('translates formulas and copies resolved formatting without copying notes', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 0 },
      {
        formula: '=B1+$C$1',
        note: 'Source note',
      },
    );
    document = setCell(
      document,
      worksheet.id,
      { row: 2, column: 0 },
      {
        value: 'old',
        valueType: 'text',
        note: 'Destination note',
      },
    );
    document = applyStyleToSelection(
      document,
      worksheet.id,
      createSelection({ row: 0, column: 0 }),
      { bold: true },
    );

    const result = fillSheetSelection(
      document,
      worksheet.id,
      createSelection({ row: 0, column: 0 }),
      { row: 2, column: 0 },
    );
    const target = getCell(activeWorksheet(result.document), { row: 2, column: 0 });

    expect(target?.formula).toBe('=B3+$C$1');
    expect(target?.note).toBe('Destination note');
    expect(
      resolveCellStyle(result.document.styles, activeWorksheet(result.document), {
        row: 2,
        column: 0,
      }),
    ).toMatchObject({ bold: true });
  });

  it('continues ISO date series', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 0 },
      {
        value: '2026-07-01',
        valueType: 'date',
      },
    );
    document = setCell(
      document,
      worksheet.id,
      { row: 1, column: 0 },
      {
        value: '2026-07-03',
        valueType: 'date',
      },
    );
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), {
      row: 1,
      column: 0,
    });

    const result = fillSheetSelection(document, worksheet.id, selection, { row: 3, column: 0 });
    expect(getCell(activeWorksheet(result.document), { row: 3, column: 0 })?.value).toBe(
      '2026-07-07',
    );
  });
});
