import { describe, expect, it } from 'vitest';

import {
  clearSheetTableFilters,
  createSheetTable,
  removeDuplicateSheetRows,
  removeSheetTable,
  setSheetTableColumnFilter,
  sortSheetTable,
  splitSheetTextToColumns,
  tableAtPosition,
  trimSheetText,
  uniqueTableColumnColors,
  uniqueTableColumnValues,
} from './dataTools';
import { createEmptySheetDocument } from './document';
import { activeWorksheet, getCell, setCell } from './operations';
import { createSelection, extendSelection } from './selection';
import { applyStyleToSelection } from './styles';

function fixture() {
  let document = createEmptySheetDocument('Data', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 8, columns: 5 },
  });
  const worksheet = activeWorksheet(document);
  const values = [
    ['Name', 'Score', 'Group'],
    ['Beta', 20, 'B'],
    ['Alpha', 20, 'A'],
    ['Gamma', 5, 'A'],
  ] as const;
  values.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) => {
      document = setCell(
        document,
        worksheet.id,
        { row: rowIndex, column: columnIndex },
        {
          value,
          valueType: typeof value === 'number' ? 'number' : 'text',
        },
      );
    }),
  );
  const selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 3, column: 2 });
  return createSheetTable(document, worksheet.id, selection, 'Results');
}

describe('structured sheet tables', () => {
  it('creates a stable table with unique header names and removes only its metadata', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    const table = worksheet.tables?.[0];
    expect(table).toMatchObject({
      name: 'Results',
      hasHeaderRow: true,
    });
    expect(table?.columns.map((column) => column.name)).toEqual(['Name', 'Score', 'Group']);
    expect(new Set(table?.columns.map((column) => column.id)).size).toBe(3);
    expect(tableAtPosition(worksheet, { row: 2, column: 1 })?.id).toBe(table?.id);

    document = removeSheetTable(document, worksheet.id, table!.id);
    expect(activeWorksheet(document).tables).toBeUndefined();
    expect(getCell(activeWorksheet(document), { row: 1, column: 0 })?.value).toBe('Beta');
  });

  it('rejects overlapping tables', () => {
    const document = fixture();
    const worksheet = activeWorksheet(document);
    const overlap = extendSelection(createSelection({ row: 2, column: 1 }), { row: 5, column: 3 });
    expect(() => createSheetTable(document, worksheet.id, overlap, 'Overlap')).toThrowError(
      /cannot overlap/i,
    );
  });
});

describe('bounded cleanup tools', () => {
  it('trims text, splits columns, and compacts duplicate rows', () => {
    let document = createEmptySheetDocument('Cleanup', {
      worksheet: { rows: 5, columns: 4 },
    });
    let worksheet = activeWorksheet(document);
    for (const [row, value] of ['  A, 1 ', 'A, 1', 'B, 2'].entries()) {
      document = setCell(
        document,
        worksheet.id,
        { row, column: 0 },
        {
          value,
          valueType: 'text',
        },
      );
    }
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), {
      row: 2,
      column: 0,
    });
    document = trimSheetText(document, worksheet.id, selection);
    document = splitSheetTextToColumns(document, worksheet.id, selection);
    worksheet = activeWorksheet(document);
    const twoColumns = extendSelection(createSelection({ row: 0, column: 0 }), {
      row: 2,
      column: 1,
    });
    document = removeDuplicateSheetRows(document, worksheet.id, twoColumns);
    worksheet = activeWorksheet(document);
    expect(getCell(worksheet, { row: 0, column: 0 })?.value).toBe('A');
    expect(getCell(worksheet, { row: 0, column: 1 })?.value).toBe('1');
    expect(getCell(worksheet, { row: 1, column: 0 })?.value).toBe('B');
    expect(getCell(worksheet, { row: 2, column: 0 })).toBeUndefined();
  });
});

describe('table sorting and filtering', () => {
  it('sorts by multiple typed columns and translates moved formulas', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    const table = worksheet.tables![0];
    document = setCell(document, worksheet.id, { row: 1, column: 3 }, { formula: '=B2*2' });
    // Extend the semantic table to include the formula column for this fixture.
    table.range.endColumnId = worksheet.columnOrder[3];
    table.columns.push({
      id: 'formula-column',
      name: 'Double',
      columnId: worksheet.columnOrder[3],
    });

    document = sortSheetTable(document, worksheet.id, table.id, [
      { columnId: worksheet.columnOrder[1], direction: 'descending' },
      { columnId: worksheet.columnOrder[0], direction: 'ascending' },
    ]);
    worksheet = activeWorksheet(document);

    expect(getCell(worksheet, { row: 1, column: 0 })?.value).toBe('Alpha');
    expect(getCell(worksheet, { row: 2, column: 0 })?.value).toBe('Beta');
    expect(getCell(worksheet, { row: 2, column: 3 })?.formula).toBe('=B3*2');
    expect(worksheet.filters?.sortRules).toHaveLength(2);
  });

  it('filters values without losing manually hidden rows and clears cleanly', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    const table = worksheet.tables![0];
    worksheet.rows = {
      [worksheet.rowOrder[3]]: { id: worksheet.rowOrder[3], hidden: true },
    };
    document = {
      ...document,
      worksheets: [worksheet],
    };

    const groupColumn = table.columns[2].columnId;
    document = setSheetTableColumnFilter(document, worksheet.id, table.id, groupColumn, {
      columnId: groupColumn,
      includeValues: ['A'],
    });
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[1]]?.filterHidden).toBe(true);
    expect(worksheet.rows?.[worksheet.rowOrder[2]]?.filterHidden).toBeUndefined();
    expect(uniqueTableColumnValues(worksheet, table, groupColumn)).toEqual(['A', 'B']);

    document = clearSheetTableFilters(document, worksheet.id);
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[1]]?.filterHidden).toBeUndefined();
    expect(worksheet.rows?.[worksheet.rowOrder[3]]?.hidden).toBe(true);
  });

  it('combines text, number, date, blank, and resolved color predicates', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    const table = worksheet.tables![0];

    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[0].columnId,
      { columnId: table.columns[0].columnId, textContains: 'mm' },
    );
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[1]]?.filterHidden).toBe(true);
    expect(worksheet.rows?.[worksheet.rowOrder[3]]?.filterHidden).toBeUndefined();

    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[0].columnId,
      null,
    );
    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[1].columnId,
      { columnId: table.columns[1].columnId, numberMin: 10, numberMax: 20 },
    );
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[3]]?.filterHidden).toBe(true);

    document = setCell(
      document,
      worksheet.id,
      { row: 1, column: 2 },
      {
        value: '2026-07-01',
        valueType: 'date',
      },
    );
    document = setCell(
      document,
      worksheet.id,
      { row: 2, column: 2 },
      {
        value: '2026-07-15',
        valueType: 'date',
      },
    );
    document = setCell(
      document,
      worksheet.id,
      { row: 3, column: 2 },
      {
        value: '',
        valueType: 'text',
      },
    );
    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[1].columnId,
      null,
    );
    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[2].columnId,
      { columnId: table.columns[2].columnId, dateFrom: '2026-07-10', hideBlanks: true },
    );
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[1]]?.filterHidden).toBe(true);
    expect(worksheet.rows?.[worksheet.rowOrder[2]]?.filterHidden).toBeUndefined();
    expect(worksheet.rows?.[worksheet.rowOrder[3]]?.filterHidden).toBe(true);

    document = clearSheetTableFilters(document, worksheet.id);
    document = applyStyleToSelection(
      document,
      worksheet.id,
      createSelection({ row: 1, column: 0 }),
      { backgroundColor: '#ff0000', color: '#ffffff' },
    );
    worksheet = activeWorksheet(document);
    expect(uniqueTableColumnColors(document, worksheet, table, table.columns[0].columnId)).toEqual({
      backgroundColors: ['#ff0000'],
      textColors: ['#ffffff'],
    });

    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[0].columnId,
      { columnId: table.columns[0].columnId, backgroundColors: ['#ff0000'] },
    );
    worksheet = activeWorksheet(document);
    expect(worksheet.rows?.[worksheet.rowOrder[1]]?.filterHidden).toBeUndefined();
    expect(worksheet.rows?.[worksheet.rowOrder[2]]?.filterHidden).toBe(true);
    expect(worksheet.rows?.[worksheet.rowOrder[3]]?.filterHidden).toBe(true);
  });
});
