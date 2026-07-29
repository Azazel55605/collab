import { describe, expect, it } from 'vitest';

import {
  addSelectionRange,
  advanceAfterCommit,
  createSelection,
  extendSelection,
  isCellSelected,
  moveSelection,
  moveToEdge,
  normalizeRange,
  selectAll,
  selectColumns,
  selectRows,
  selectedCellCount,
  selectedPositions,
} from './selection';

const BOUNDS = { rowCount: 10, columnCount: 5 };

describe('range normalization', () => {
  it('orders anchor and focus regardless of drag direction', () => {
    const forward = normalizeRange({ anchor: { row: 1, column: 1 }, focus: { row: 3, column: 4 } });
    const backward = normalizeRange({ anchor: { row: 3, column: 4 }, focus: { row: 1, column: 1 } });
    expect(forward).toEqual({ top: 1, left: 1, bottom: 3, right: 4 });
    expect(backward).toEqual(forward);
  });
});

describe('selection construction', () => {
  it('selects a single cell', () => {
    const selection = createSelection({ row: 2, column: 3 });
    expect(selection.active).toEqual({ row: 2, column: 3 });
    expect(selectedCellCount(selection)).toBe(1);
    expect(isCellSelected(selection, { row: 2, column: 3 })).toBe(true);
    expect(isCellSelected(selection, { row: 2, column: 4 })).toBe(false);
  });

  it('extends the active range to a focus cell', () => {
    const selection = extendSelection(createSelection({ row: 1, column: 1 }), { row: 3, column: 2 });
    expect(selectedCellCount(selection)).toBe(6);
    // The anchor stays put while the focus moves.
    expect(selection.ranges[0].anchor).toEqual({ row: 1, column: 1 });
  });

  it('keeps disjoint ranges and de-duplicates their overlap', () => {
    let selection = createSelection({ row: 0, column: 0 });
    selection = extendSelection(selection, { row: 1, column: 1 });
    selection = addSelectionRange(selection, { row: 1, column: 1 });
    selection = extendSelection(selection, { row: 2, column: 2 });

    expect(selection.ranges).toHaveLength(2);
    // 4 cells + 4 cells, sharing exactly one.
    expect(selectedCellCount(selection)).toBe(7);
    expect(selectedPositions(selection).filter((p) => p.row === 1 && p.column === 1)).toHaveLength(1);
  });

  it('selects whole rows, columns, and the entire grid', () => {
    const rows = selectRows(2, 4, BOUNDS);
    expect(rows.kind).toBe('rows');
    expect(selectedCellCount(rows)).toBe(3 * BOUNDS.columnCount);

    const columns = selectColumns(4, 1, BOUNDS);
    expect(columns.kind).toBe('columns');
    expect(selectedCellCount(columns)).toBe(4 * BOUNDS.rowCount);

    const all = selectAll(BOUNDS);
    expect(all.kind).toBe('all');
    expect(selectedCellCount(all)).toBe(BOUNDS.rowCount * BOUNDS.columnCount);
  });
});

describe('navigation', () => {
  it('moves the active cell and clamps at the edges', () => {
    let selection = createSelection({ row: 0, column: 0 });
    selection = moveSelection(selection, 'up', BOUNDS);
    expect(selection.active).toEqual({ row: 0, column: 0 });

    selection = moveSelection(selection, 'down', BOUNDS);
    expect(selection.active).toEqual({ row: 1, column: 0 });

    selection = moveSelection(selection, 'right', BOUNDS, { distance: 99 });
    expect(selection.active).toEqual({ row: 1, column: BOUNDS.columnCount - 1 });
  });

  it('extends instead of moving when shift is held', () => {
    let selection = createSelection({ row: 1, column: 1 });
    selection = moveSelection(selection, 'down', BOUNDS, { extend: true });
    selection = moveSelection(selection, 'right', BOUNDS, { extend: true });

    expect(selection.active).toEqual({ row: 1, column: 1 });
    expect(normalizeRange(selection.ranges[0])).toEqual({ top: 1, left: 1, bottom: 2, right: 2 });
  });

  it('jumps to the end of a populated block, then to the next block, then the edge', () => {
    // Column 0 populated at rows 0-2 and row 6.
    const populated = new Set(['0:0', '1:0', '2:0', '6:0']);
    const isPopulated = ({ row, column }: { row: number; column: number }) => populated.has(`${row}:${column}`);

    let selection = createSelection({ row: 0, column: 0 });
    selection = moveSelection(selection, 'down', BOUNDS, { jump: true, isPopulated });
    expect(selection.active).toEqual({ row: 2, column: 0 });

    selection = moveSelection(selection, 'down', BOUNDS, { jump: true, isPopulated });
    expect(selection.active).toEqual({ row: 6, column: 0 });

    selection = moveSelection(selection, 'down', BOUNDS, { jump: true, isPopulated });
    expect(selection.active).toEqual({ row: BOUNDS.rowCount - 1, column: 0 });
  });

  it('moves to row and grid edges', () => {
    const start = createSelection({ row: 4, column: 2 });
    expect(moveToEdge(start, 'row-start', BOUNDS).active).toEqual({ row: 4, column: 0 });
    expect(moveToEdge(start, 'row-end', BOUNDS).active).toEqual({ row: 4, column: 4 });
    expect(moveToEdge(start, 'grid-start', BOUNDS).active).toEqual({ row: 0, column: 0 });
    expect(moveToEdge(start, 'grid-end', BOUNDS).active).toEqual({ row: 9, column: 4 });

    const extended = moveToEdge(start, 'row-end', BOUNDS, true);
    expect(normalizeRange(extended.ranges[0])).toEqual({ top: 4, left: 2, bottom: 4, right: 4 });
  });
});

describe('advanceAfterCommit', () => {
  it('steps in the commit direction for a single cell', () => {
    const selection = createSelection({ row: 1, column: 1 });
    expect(advanceAfterCommit(selection, 'down', BOUNDS).active).toEqual({ row: 2, column: 1 });
    expect(advanceAfterCommit(selection, 'right', BOUNDS).active).toEqual({ row: 1, column: 2 });
  });

  it('cycles within a multi-cell selection instead of leaving it', () => {
    let selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 });

    selection = advanceAfterCommit(selection, 'down', BOUNDS);
    expect(selection.active).toEqual({ row: 1, column: 0 });
    // Past the bottom of the block: wrap to the top of the next column.
    selection = advanceAfterCommit(selection, 'down', BOUNDS);
    expect(selection.active).toEqual({ row: 0, column: 1 });
    selection = advanceAfterCommit(selection, 'down', BOUNDS);
    expect(selection.active).toEqual({ row: 1, column: 1 });
    // Past the last cell: wrap back to the start of the block.
    selection = advanceAfterCommit(selection, 'down', BOUNDS);
    expect(selection.active).toEqual({ row: 0, column: 0 });
    // The selection itself is preserved throughout.
    expect(selectedCellCount(selection)).toBe(4);
  });

  it('wraps by row when tabbing', () => {
    let selection = extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 1 });
    selection = advanceAfterCommit(selection, 'right', BOUNDS);
    expect(selection.active).toEqual({ row: 0, column: 1 });
    selection = advanceAfterCommit(selection, 'right', BOUNDS);
    expect(selection.active).toEqual({ row: 1, column: 0 });
  });
});
