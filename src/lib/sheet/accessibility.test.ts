import { describe, expect, it } from 'vitest';

import type { SheetWorksheet } from '../../types/sheet';

import { describeSheetCell, describeSheetSelection, sheetActiveCellDomId } from './accessibility';
import {
  createSelection,
  extendSelection,
  selectAll,
  selectColumns,
  selectRows,
} from './selection';

const worksheet: SheetWorksheet = {
  id: 'ws1',
  name: 'Sheet1',
  rowOrder: ['r1', 'r2', 'r3'],
  columnOrder: ['c1', 'c2', 'c3'],
  cells: {
    'r1:c1': { value: 'Rent', valueType: 'text' },
    'r1:c2': { value: 1240, valueType: 'number' },
    'r2:c1': { formula: '=A1', note: 'Check this' },
    'r2:c2': { value: 'Linked', valueType: 'text', link: 'Notes/Budget.md' },
    'r3:c1': {
      value: 'Docs',
      valueType: 'text',
      attachments: [{ id: 'a1', relativePath: 'Pictures/plan.png' }],
    },
  },
};

const bounds = { rowCount: 3, columnCount: 3 };

describe('describeSheetCell', () => {
  it('reads the address and the displayed content', () => {
    expect(describeSheetCell({ worksheet, position: { row: 0, column: 0 } })).toBe('A1, Rent');
    expect(describeSheetCell({ worksheet, position: { row: 0, column: 1 } })).toBe('B1, 1240');
  });

  it('says a blank cell is empty rather than saying nothing', () => {
    expect(describeSheetCell({ worksheet, position: { row: 2, column: 2 } })).toBe('C3, empty');
  });

  it('reads both the result and the source of a formula cell', () => {
    const description = describeSheetCell({
      worksheet,
      position: { row: 1, column: 0 },
      computed: { type: 'text', value: 'Rent' },
    });
    expect(description).toContain('A2');
    expect(description).toContain('formula =A1');
    expect(description).toContain('has note');
  });

  it('announces a formula whose value has not been computed yet', () => {
    expect(describeSheetCell({ worksheet, position: { row: 1, column: 0 } })).toContain(
      'formula =A1',
    );
  });

  it('mentions links and attachments', () => {
    expect(describeSheetCell({ worksheet, position: { row: 1, column: 1 } })).toContain('has link');
    expect(describeSheetCell({ worksheet, position: { row: 2, column: 0 } })).toContain(
      '1 attachment',
    );
  });
});

describe('describeSheetSelection', () => {
  it('reads the cell itself for a single-cell selection', () => {
    const selection = createSelection({ row: 0, column: 0 });
    expect(describeSheetSelection({ worksheet, selection, position: selection.active })).toBe(
      'A1, Rent',
    );
  });

  it('describes the shape of a range instead of every cell in it', () => {
    const selection = extendSelection(createSelection({ row: 0, column: 0 }), {
      row: 2,
      column: 2,
    });
    const description = describeSheetSelection({
      worksheet,
      selection,
      position: selection.active,
    });
    expect(description).toContain('3 by 3 range selected');
    expect(description).toContain('A1 to C3');
    // The active cell is still identified, so the user knows where typing lands.
    expect(description).toContain('A1, Rent');
  });

  it('describes row, column, and whole-sheet selections', () => {
    expect(
      describeSheetSelection({
        worksheet,
        selection: selectRows(0, 1, bounds),
        position: { row: 0, column: 0 },
      }),
    ).toContain('Rows 1 to 2 selected');

    expect(
      describeSheetSelection({
        worksheet,
        selection: selectColumns(1, 2, bounds),
        position: { row: 0, column: 1 },
      }),
    ).toContain('Columns B to C selected');

    expect(
      describeSheetSelection({
        worksheet,
        selection: selectAll(bounds),
        position: { row: 0, column: 0 },
      }),
    ).toContain('All cells selected, 3 rows by 3 columns');
  });

  it('reports how many disjoint ranges are selected', () => {
    const first = createSelection({ row: 0, column: 0 });
    const selection = {
      ...first,
      ranges: [...first.ranges, { anchor: { row: 2, column: 2 }, focus: { row: 2, column: 2 } }],
    };
    expect(describeSheetSelection({ worksheet, selection, position: selection.active })).toContain(
      '2 ranges selected, 2 cells',
    );
  });

  it('states read-only and protected status, because they change what typing does', () => {
    const selection = createSelection({ row: 0, column: 0 });
    const description = describeSheetSelection({
      worksheet,
      selection,
      position: selection.active,
      readOnly: true,
      protected: true,
    });
    expect(description).toContain('protected');
    expect(description).toContain('read only');
  });
});

describe('sheetActiveCellDomId', () => {
  it('derives a stable id from the grid id', () => {
    expect(sheetActiveCellDomId(':r1:')).toBe(':r1:-active-cell');
  });
});
