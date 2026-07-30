import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { activeWorksheet, getCell, setCell } from './operations';
import { createSelection, extendSelection, selectColumns, selectRows } from './selection';
import {
  applyStyleToSelection,
  clearStylesFromSelection,
  resolveCellStyle,
} from './styles';

function workbook() {
  return createEmptySheetDocument('Book', {
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { rows: 6, columns: 4 },
  });
}

describe('sheet styles', () => {
  it('deduplicates equal styles across a range without changing values', () => {
    let document = workbook();
    const worksheetId = activeWorksheet(document).id;
    document = setCell(document, worksheetId, { row: 0, column: 0 }, { value: 4, valueType: 'number' });
    document = applyStyleToSelection(
      document,
      worksheetId,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
      { bold: true, backgroundColor: '#ef4444' },
    );

    const worksheet = activeWorksheet(document);
    expect(Object.keys(document.styles)).toHaveLength(1);
    const styleIds = new Set(Object.values(worksheet.cells).map((cell) => cell.styleId));
    expect(styleIds.size).toBe(1);
    expect(getCell(worksheet, { row: 0, column: 0 })?.value).toBe(4);
    expect(resolveCellStyle(document.styles, worksheet, { row: 1, column: 1 })).toMatchObject({
      bold: true,
      backgroundColor: '#ef4444',
    });
  });

  it('inherits column then row then cell styles', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    const bounds = { rowCount: worksheet.rowOrder.length, columnCount: worksheet.columnOrder.length };
    document = applyStyleToSelection(document, worksheet.id, selectColumns(1, 1, bounds), { bold: true });
    document = applyStyleToSelection(document, worksheet.id, selectRows(2, 2, bounds), { color: '#3b82f6' });
    document = applyStyleToSelection(document, worksheet.id, createSelection({ row: 2, column: 1 }), { bold: false });

    expect(resolveCellStyle(document.styles, activeWorksheet(document), { row: 2, column: 1 }))
      .toMatchObject({ bold: false, color: '#3b82f6' });
  });

  it('clears formatting and prunes styles that are no longer referenced', () => {
    let document = workbook();
    const worksheetId = activeWorksheet(document).id;
    const selection = createSelection({ row: 0, column: 0 });
    document = applyStyleToSelection(document, worksheetId, selection, { italic: true });
    expect(Object.keys(document.styles)).toHaveLength(1);

    document = clearStylesFromSelection(document, worksheetId, selection);
    expect(Object.keys(document.styles)).toHaveLength(0);
    expect(getCell(activeWorksheet(document), { row: 0, column: 0 })).toBeUndefined();
  });
});
