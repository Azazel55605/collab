import { describe, expect, it } from 'vitest';

import { sheetCellKey } from '../../types/sheet';
import type { SheetDocument } from '../../types/sheet';
import { createEmptySheetDocument } from './document';
import {
  activeWorksheet,
  autoSizeColumn,
  clearCells,
  deleteTracks,
  duplicateWorksheet,
  getCell,
  insertTracks,
  mergeSelection,
  mergedRangeAt,
  moveTracks,
  reorderWorksheet,
  resizeTrack,
  setActiveWorksheet,
  setCell,
  setFrozen,
  setTrackHidden,
  setWorksheetHidden,
  unmergeSelection,
  worksheetById,
} from './operations';
import { createSelection, extendSelection, selectRows } from './selection';

function workbook(): SheetDocument {
  return createEmptySheetDocument('Book', {
    timestamp: '2026-01-01T00:00:00.000Z',
    worksheet: { name: 'Sheet1', rows: 6, columns: 4 },
  });
}

function withCells(document: SheetDocument): SheetDocument {
  const worksheet = activeWorksheet(document);
  let next = document;
  next = setCell(next, worksheet.id, { row: 0, column: 0 }, { value: 'A1', valueType: 'text' });
  next = setCell(next, worksheet.id, { row: 1, column: 1 }, { value: 2, valueType: 'number' });
  next = setCell(next, worksheet.id, { row: 2, column: 2 }, { value: 3, valueType: 'number' });
  return next;
}

describe('cells', () => {
  it('writes and clears cells in the sparse map', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);

    const written = setCell(document, worksheet.id, { row: 1, column: 2 }, { value: 7, valueType: 'number' });
    expect(getCell(activeWorksheet(written), { row: 1, column: 2 })).toEqual({ value: 7, valueType: 'number' });

    const cleared = setCell(written, worksheet.id, { row: 1, column: 2 }, null);
    expect(Object.keys(activeWorksheet(cleared).cells)).toHaveLength(0);
  });

  it('never mutates the input document', () => {
    const document = workbook();
    const before = JSON.stringify(document);
    setCell(document, activeWorksheet(document).id, { row: 0, column: 0 }, { value: 1 });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('preserves an existing cell style when only the value changes', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);
    const styled = setCell(document, worksheet.id, { row: 0, column: 0 }, { value: 1, styleId: 's1' });
    const revalued = setCell(styled, worksheet.id, { row: 0, column: 0 }, { value: 2, valueType: 'number' });
    expect(getCell(activeWorksheet(revalued), { row: 0, column: 0 })).toEqual({
      value: 2,
      valueType: 'number',
      styleId: 's1',
    });
  });

  it('clears every cell in a selection', () => {
    const document = withCells(workbook());
    const worksheet = activeWorksheet(document);
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 });

    const cleared = clearCells(document, worksheet.id, selection);
    expect(Object.keys(activeWorksheet(cleared).cells)).toHaveLength(1);
    expect(getCell(activeWorksheet(cleared), { row: 2, column: 2 })).toBeDefined();
  });
});

describe('rows and columns', () => {
  it('inserts tracks without disturbing existing cell identities', () => {
    const document = withCells(workbook());
    const worksheet = activeWorksheet(document);
    const originalKey = sheetCellKey(worksheet.rowOrder[2], worksheet.columnOrder[2]);

    const inserted = insertTracks(document, worksheet.id, 'row', 0, 2);
    const next = activeWorksheet(inserted);

    expect(next.rowOrder).toHaveLength(8);
    // The cell keeps its key; only its position moved down by two.
    expect(next.cells[originalKey]).toBeDefined();
    expect(next.rowOrder.indexOf(worksheet.rowOrder[2])).toBe(4);
  });

  it('deletes tracks and prunes their cells, sizes, and merges', () => {
    let document = withCells(workbook());
    const worksheet = activeWorksheet(document);
    document = resizeTrack(document, worksheet.id, 'row', 1, 60);
    document = mergeSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 1, column: 0 }), { row: 1, column: 1 }),
    );

    const deleted = deleteTracks(document, worksheet.id, 'row', 1, 1);
    const next = activeWorksheet(deleted);

    expect(next.rowOrder).toHaveLength(5);
    expect(next.rows?.[worksheet.rowOrder[1]]).toBeUndefined();
    expect(next.mergedRanges).toBeUndefined();
    expect(Object.keys(next.cells)).toHaveLength(2);
  });

  it('refuses to delete the last row or column', () => {
    const document = createEmptySheetDocument('Book', { worksheet: { rows: 1, columns: 1 } });
    const worksheet = activeWorksheet(document);
    expect(() => deleteTracks(document, worksheet.id, 'row', 0, 1)).toThrowError(/at least one row/);
    expect(() => deleteTracks(document, worksheet.id, 'column', 0, 1)).toThrowError(/at least one column/);
  });

  it('moves a block of tracks', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);
    const [a, b, c, d] = worksheet.columnOrder;

    const moved = moveTracks(document, worksheet.id, 'column', 0, 2, 2);
    expect(activeWorksheet(moved).columnOrder).toEqual([c, d, a, b]);
  });

  it('resizes and hides tracks', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);

    const resized = resizeTrack(document, worksheet.id, 'column', 1, 220);
    expect(activeWorksheet(resized).columns?.[worksheet.columnOrder[1]].width).toBe(220);

    const hidden = setTrackHidden(resized, worksheet.id, 'row', [0, 1], true);
    expect(activeWorksheet(hidden).rows?.[worksheet.rowOrder[0]].hidden).toBe(true);

    const shown = setTrackHidden(hidden, worksheet.id, 'row', [0], false);
    expect(activeWorksheet(shown).rows?.[worksheet.rowOrder[0]].hidden).toBeUndefined();
  });

  it('enforces a minimum size on resize', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);
    const resized = resizeTrack(document, worksheet.id, 'column', 0, -50);
    expect(activeWorksheet(resized).columns?.[worksheet.columnOrder[0]].width).toBe(24);
  });

  it('auto-sizes a column from its widest populated cell', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 0, column: 0 }, { value: 'short', valueType: 'text' });
    document = setCell(document, worksheet.id, { row: 1, column: 0 }, { value: 'a much longer value', valueType: 'text' });

    const measure = (text: string) => text.length * 7;
    const sized = autoSizeColumn(document, worksheet.id, 0, measure, { padding: 10 });
    expect(activeWorksheet(sized).columns?.[worksheet.columnOrder[0]].width)
      .toBe('a much longer value'.length * 7 + 10);
  });
});

describe('merged ranges', () => {
  it('merges a rectangle, keeping only the top-left content', () => {
    let document = withCells(workbook());
    const worksheet = activeWorksheet(document);
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 });

    document = mergeSelection(document, worksheet.id, selection);
    const next = activeWorksheet(document);

    expect(next.mergedRanges).toHaveLength(1);
    expect(getCell(next, { row: 0, column: 0 })?.value).toBe('A1');
    expect(getCell(next, { row: 1, column: 1 })).toBeUndefined();
    expect(mergedRangeAt(next, { row: 1, column: 0 })).not.toBeNull();
    expect(mergedRangeAt(next, { row: 2, column: 2 })).toBeNull();
  });

  it('rejects single cells and overlapping merges', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    expect(() => mergeSelection(document, worksheet.id, createSelection({ row: 0, column: 0 })))
      .toThrowError(/more than one cell/);

    document = mergeSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
    );
    expect(() => mergeSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 1, column: 1 }), { row: 2, column: 2 }),
    )).toThrowError(/overlaps/);
  });

  it('unmerges every range touching the selection', () => {
    let document = workbook();
    const worksheet = activeWorksheet(document);
    document = mergeSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 }),
    );
    document = unmergeSelection(document, worksheet.id, createSelection({ row: 1, column: 1 }));
    expect(activeWorksheet(document).mergedRanges).toBeUndefined();
  });
});

describe('frozen panes', () => {
  it('clamps frozen counts to the worksheet size', () => {
    const document = workbook();
    const worksheet = activeWorksheet(document);
    const frozen = setFrozen(document, worksheet.id, { rows: 2, columns: 99 });
    expect(activeWorksheet(frozen).frozen).toEqual({ rows: 2, columns: 4 });
  });
});

describe('worksheets', () => {
  it('duplicates a worksheet with fresh identities and copied content', () => {
    const document = withCells(workbook());
    const source = activeWorksheet(document);

    const duplicated = duplicateWorksheet(document, source.id);
    const copy = worksheetById(duplicated, duplicated.activeWorksheetId)!;

    expect(duplicated.worksheets).toHaveLength(2);
    expect(copy.name).toBe('Sheet1 copy');
    expect(copy.id).not.toBe(source.id);
    expect(copy.rowOrder.some((id) => source.rowOrder.includes(id))).toBe(false);
    expect(copy.columnOrder.some((id) => source.columnOrder.includes(id))).toBe(false);
    expect(Object.keys(copy.cells)).toHaveLength(Object.keys(source.cells).length);
    expect(getCell(copy, { row: 0, column: 0 })?.value).toBe('A1');
  });

  it('reorders worksheets', () => {
    let document = workbook();
    const first = activeWorksheet(document).id;
    document = duplicateWorksheet(document, first);
    const second = document.worksheets[1].id;

    document = reorderWorksheet(document, second, 0);
    expect(document.worksheets.map((worksheet) => worksheet.id)).toEqual([second, first]);
  });

  it('hides a worksheet and moves the active sheet off it', () => {
    let document = workbook();
    const first = activeWorksheet(document).id;
    document = duplicateWorksheet(document, first);
    document = setActiveWorksheet(document, first);

    document = setWorksheetHidden(document, first, true);
    expect(worksheetById(document, first)?.hidden).toBe(true);
    expect(document.activeWorksheetId).not.toBe(first);
  });

  it('refuses to hide the last visible worksheet', () => {
    const document = workbook();
    const only = activeWorksheet(document).id;
    expect(() => setWorksheetHidden(document, only, true)).toThrowError(/at least one visible/);
  });

  it('selects whole rows for structural commands', () => {
    const document = withCells(workbook());
    const worksheet = activeWorksheet(document);
    const selection = selectRows(0, 1, {
      rowCount: worksheet.rowOrder.length,
      columnCount: worksheet.columnOrder.length,
    });
    const cleared = clearCells(document, worksheet.id, selection);
    expect(Object.keys(activeWorksheet(cleared).cells)).toHaveLength(1);
  });
});
