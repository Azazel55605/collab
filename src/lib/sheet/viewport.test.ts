import { describe, expect, it } from 'vitest';

import { SHEET_DEFAULTS, SHEET_LIMITS } from '../../types/sheet';

import { createWorksheetFixture } from './fixture';
import {
  buildColumnMetrics,
  buildRowMetrics,
  computeViewport,
  trackAtOffset,
  trackOffset,
  trackSize,
} from './viewport';

const worksheet = createWorksheetFixture({
  rows: 1_000,
  columns: 100,
  populatedRows: 100,
  populatedColumns: 20,
});

describe('axis metrics', () => {
  it('accumulates default sizes', () => {
    const rows = buildRowMetrics(worksheet);
    expect(rows.count).toBe(1_000);
    expect(rows.totalSize).toBe(1_000 * SHEET_DEFAULTS.rowHeight);
    expect(trackOffset(rows, 10)).toBe(10 * SHEET_DEFAULTS.rowHeight);
    expect(trackSize(rows, 10)).toBe(SHEET_DEFAULTS.rowHeight);
  });

  it('honors explicit sizes and collapses hidden tracks', () => {
    const custom = {
      ...worksheet,
      rows: {
        r1: { id: 'r1', height: 60 },
        r2: { id: 'r2', hidden: true },
      },
    };
    const rows = buildRowMetrics(custom);
    expect(trackSize(rows, 0)).toBe(60);
    expect(trackSize(rows, 1)).toBe(0);
    expect(trackOffset(rows, 2)).toBe(60);
    // A hidden row is never the hit target for a click at its offset.
    expect(trackAtOffset(rows, 60)).toBe(2);
  });

  it('finds the track at an offset by binary search', () => {
    const columns = buildColumnMetrics(worksheet);
    expect(trackAtOffset(columns, 0)).toBe(0);
    expect(trackAtOffset(columns, SHEET_DEFAULTS.columnWidth)).toBe(1);
    expect(trackAtOffset(columns, SHEET_DEFAULTS.columnWidth * 5.5)).toBe(5);
    expect(trackAtOffset(columns, -20)).toBe(0);
    expect(trackAtOffset(columns, columns.totalSize + 1_000)).toBe(columns.count - 1);
  });
});

describe('computeViewport', () => {
  const rows = buildRowMetrics(worksheet);
  const columns = buildColumnMetrics(worksheet);

  it('renders only the visible window plus overscan', () => {
    const viewport = computeViewport({
      rows,
      columns,
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 600,
      viewportWidth: 1_000,
    });

    // 600px / 24px rows = 25 visible rows, plus overscan on the trailing edge.
    expect(viewport.rows.start).toBe(0);
    expect(viewport.rows.end).toBeLessThanOrEqual(25 + 1 + SHEET_DEFAULTS.overscan);
    expect(viewport.columns.end).toBeLessThanOrEqual(10 + 1 + SHEET_DEFAULTS.overscan);
    expect(viewport.cellCount).toBeLessThan(500);
  });

  it('keeps frozen panes pinned outside the scrolling window', () => {
    const viewport = computeViewport({
      rows,
      columns,
      scrollTop: 5_000,
      scrollLeft: 2_000,
      viewportHeight: 600,
      viewportWidth: 1_000,
      frozenRows: 2,
      frozenColumns: 1,
    });

    expect(viewport.rows.frozen).toBe(2);
    expect(viewport.columns.frozen).toBe(1);
    // Frozen tracks are rendered separately, so the scrolling window never
    // starts before them.
    expect(viewport.rows.start).toBeGreaterThanOrEqual(2);
    expect(viewport.columns.start).toBeGreaterThanOrEqual(1);
    expect(viewport.rows.startOffset).toBe(viewport.rows.start * SHEET_DEFAULTS.rowHeight);
  });

  it('clamps at both ends of the scroll range', () => {
    const atTop = computeViewport({
      rows,
      columns,
      scrollTop: -500,
      scrollLeft: -500,
      viewportHeight: 600,
      viewportWidth: 1_000,
    });
    expect(atTop.rows.start).toBe(0);
    expect(atTop.columns.start).toBe(0);

    const atEnd = computeViewport({
      rows,
      columns,
      scrollTop: rows.totalSize * 2,
      scrollLeft: columns.totalSize * 2,
      viewportHeight: 600,
      viewportWidth: 1_000,
    });
    expect(atEnd.rows.end).toBe(rows.count);
    expect(atEnd.columns.end).toBe(columns.count);
  });

  it('renders a bounded window even at the maximum logical grid size', () => {
    const huge = createWorksheetFixture({
      rows: 5_000,
      columns: SHEET_LIMITS.columnsPerWorksheet,
      populatedRows: 0,
      populatedColumns: 0,
    });
    const hugeRows = buildRowMetrics(huge);
    const hugeColumns = buildColumnMetrics(huge);

    const started = performance.now();
    let cellCount = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      const viewport = computeViewport({
        rows: hugeRows,
        columns: hugeColumns,
        scrollTop: frame * 37,
        scrollLeft: frame * 53,
        viewportHeight: 900,
        viewportWidth: 1_600,
      });
      cellCount = viewport.cellCount;
    }
    const elapsed = performance.now() - started;

    // Independent of the logical grid: ~38 rows x ~16 columns + overscan.
    expect(cellCount).toBeLessThan(1_500);
    // 240 scroll frames is 4 seconds of 60fps scrolling.
    expect(elapsed).toBeLessThan(200);
  });
});
