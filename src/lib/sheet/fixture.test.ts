import { describe, expect, it } from 'vitest';

import { SHEET_DOCUMENT_KIND, SHEET_LIMITS, SHEET_SCHEMA_VERSION } from '../../types/sheet';
import { SheetAddressIndex } from './address';
import { createWorkbookFixture } from './fixture';
import { buildColumnMetrics, buildRowMetrics, computeViewport } from './viewport';

describe('workbook fixtures', () => {
  it('produces a schema-shaped document', () => {
    const workbook = createWorkbookFixture({
      rows: 20,
      columns: 10,
      populatedRows: 5,
      populatedColumns: 4,
      formulaColumn: true,
    });

    expect(workbook.kind).toBe(SHEET_DOCUMENT_KIND);
    expect(workbook.schemaVersion).toBe(SHEET_SCHEMA_VERSION);
    const worksheet = workbook.worksheets[0];
    expect(worksheet.rowOrder).toHaveLength(20);
    expect(worksheet.columnOrder).toHaveLength(10);
    // 5 x 4 values plus a 5-cell formula column.
    expect(Object.keys(worksheet.cells)).toHaveLength(25);
    expect(worksheet.cells['r1:c5'].formula).toBe('=SUM(A1:D1)');
  });

  it('is deterministic', () => {
    const options = { rows: 50, columns: 20, populatedRows: 10, populatedColumns: 10 };
    expect(JSON.stringify(createWorkbookFixture(options)))
      .toBe(JSON.stringify(createWorkbookFixture(options)));
  });
});

/**
 * Phase 0 scale proof: 100,000 populated cells inside a logical grid roughly
 * 160x larger. Budgets are recorded in
 * `docs/plans/advanced-tables-phase0-contract.md`; the assertions here are
 * regression guards, deliberately loose enough to survive CI variance.
 */
describe('sparse workbook at Phase 0 scale', () => {
  it('builds, serializes, and scrolls a 100,000-cell workbook within budget', () => {
    const buildStarted = performance.now();
    const workbook = createWorkbookFixture({
      rows: 100_000,
      columns: 1_000,
      populatedRows: 1_000,
      populatedColumns: 100,
    });
    const buildElapsed = performance.now() - buildStarted;

    const worksheet = workbook.worksheets[0];
    const populated = Object.keys(worksheet.cells).length;
    expect(populated).toBe(100_000);
    expect(populated).toBeLessThanOrEqual(SHEET_LIMITS.populatedCellsPerWorksheet);
    // The logical grid is far larger than the populated region.
    expect(worksheet.rowOrder.length * worksheet.columnOrder.length).toBeGreaterThan(populated * 100);
    expect(buildElapsed).toBeLessThan(3_000);

    const serializeStarted = performance.now();
    const serialized = JSON.stringify(workbook);
    const serializeElapsed = performance.now() - serializeStarted;
    expect(serialized.length).toBeLessThan(SHEET_LIMITS.documentBytes);
    expect(serializeElapsed).toBeLessThan(3_000);

    const parseStarted = performance.now();
    const reparsed = JSON.parse(serialized);
    const parseElapsed = performance.now() - parseStarted;
    expect(Object.keys(reparsed.worksheets[0].cells)).toHaveLength(100_000);
    expect(parseElapsed).toBeLessThan(3_000);

    const rows = buildRowMetrics(worksheet);
    const columns = buildColumnMetrics(worksheet);
    const index = new SheetAddressIndex(worksheet);

    // Simulate 120 scroll frames, resolving every visible cell each frame.
    const scrollStarted = performance.now();
    let lastVisible = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const viewport = computeViewport({
        rows,
        columns,
        scrollTop: frame * 41,
        scrollLeft: frame * 17,
        viewportHeight: 900,
        viewportWidth: 1_600,
        frozenRows: 1,
        frozenColumns: 1,
      });
      let visible = 0;
      for (let row = viewport.rows.start; row < viewport.rows.end; row += 1) {
        for (let column = viewport.columns.start; column < viewport.columns.end; column += 1) {
          const key = index.cellKeyAt({ row, column });
          if (key && worksheet.cells[key]) visible += 1;
        }
      }
      lastVisible = visible;
    }
    const scrollElapsed = performance.now() - scrollStarted;

    expect(lastVisible).toBeGreaterThan(0);
    // 120 frames is 2 seconds of 60fps scrolling; the whole sweep must cost far
    // less than one frame budget per frame.
    expect(scrollElapsed).toBeLessThan(500);
  });
});
