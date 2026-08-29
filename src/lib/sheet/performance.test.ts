/**
 * Phase 9 budget enforcement for the TypeScript half of `.sheet`.
 *
 * These are regression guards, not benchmarks: the measured baselines in
 * `docs/plans/advanced-tables-phase0-contract.md` sit far below the ceilings in
 * `budgets.ts`, so an ordinary slow machine passes and an order-of-magnitude
 * regression fails. The native recalculation budgets are enforced separately by
 * `crates/collab-sheet/tests/formula_proof.rs`.
 *
 * On a slow runner, set `COLLAB_SHEET_BUDGET_SCALE` and record the scale the
 * platform was validated at in the release-validation matrix.
 */
import { describe, expect, it } from 'vitest';

import { SheetAddressIndex } from './address';
import { sheetTimeBudget } from './budgets';
import { createSheetClipboardPayload, pasteSheetClipboardPayload } from './clipboard';
import { parseSheetDocument, serializeSheetDocument } from './document';
import { createSparseWorkbookFixture, createTallWorkbookFixture } from './fixture';
import { setCells } from './operations';
import type { SheetCellWrite } from './operations';
import { createSelection, extendSelection } from './selection';
import { buildColumnMetrics, buildRowMetrics, computeViewport } from './viewport';

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('Phase 9 performance budgets', () => {
  it('opens a 100,000-cell workbook within the first-open budget', () => {
    const text = serializeSheetDocument(createSparseWorkbookFixture());

    let worksheet = createSparseWorkbookFixture().worksheets[0];
    const open = elapsed(() => {
      // First open is parse + normalize + the indexes the grid needs to paint.
      const document = parseSheetDocument(text);
      worksheet = document.worksheets[0];
      buildRowMetrics(worksheet);
      buildColumnMetrics(worksheet);
      new SheetAddressIndex(worksheet);
    });

    expect(Object.keys(worksheet.cells)).toHaveLength(100_000);
    expect(open).toBeLessThan(sheetTimeBudget('firstOpenMs'));
  });

  it('serializes a save within the save budget', () => {
    const document = createSparseWorkbookFixture();
    // Warm the shape so the measurement is serialization, not first-touch.
    serializeSheetDocument(document);
    expect(elapsed(() => serializeSheetDocument(document))).toBeLessThan(
      sheetTimeBudget('saveSerializeMs'),
    );
  });

  it('resolves a scroll frame within the per-frame budget', () => {
    const worksheet = createSparseWorkbookFixture().worksheets[0];
    const rows = buildRowMetrics(worksheet);
    const columns = buildColumnMetrics(worksheet);
    const index = new SheetAddressIndex(worksheet);

    const frames = 120;
    let visible = 0;
    const total = elapsed(() => {
      for (let frame = 0; frame < frames; frame += 1) {
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
        visible = 0;
        for (let row = viewport.rows.start; row < viewport.rows.end; row += 1) {
          for (let column = viewport.columns.start; column < viewport.columns.end; column += 1) {
            const key = index.cellKeyAt({ row, column });
            if (key && worksheet.cells[key]) visible += 1;
          }
        }
      }
    });

    expect(visible).toBeGreaterThan(0);
    expect(total / frames).toBeLessThan(sheetTimeBudget('scrollFrameMs'));
  });

  it('scrolls a very tall worksheet at the same per-frame cost', () => {
    // Cumulative axis offsets plus binary-search hit testing must not make
    // frame cost depend on how far down the sheet the viewport sits.
    const worksheet = createTallWorkbookFixture(150_000).worksheets[0];
    const rows = buildRowMetrics(worksheet);
    const columns = buildColumnMetrics(worksheet);

    const frameCost = (scrollTop: number) =>
      elapsed(() => {
        for (let frame = 0; frame < 60; frame += 1) {
          computeViewport({
            rows,
            columns,
            scrollTop: scrollTop + frame,
            scrollLeft: 0,
            viewportHeight: 900,
            viewportWidth: 1_600,
            frozenRows: 0,
            frozenColumns: 0,
          });
        }
      }) / 60;

    expect(frameCost(0)).toBeLessThan(sheetTimeBudget('scrollFrameMs'));
    expect(frameCost(3_000_000)).toBeLessThan(sheetTimeBudget('scrollFrameMs'));
  });

  it('pastes 10,000 cells into a large worksheet within the paste budget', () => {
    const document = createSparseWorkbookFixture();
    const worksheet = document.worksheets[0];
    const source = extendSelection(createSelection({ row: 0, column: 0 }), { row: 99, column: 99 });
    const payload = createSheetClipboardPayload(document, worksheet, source);
    expect(payload.rows * payload.columns).toBe(10_000);

    let pasted = document;
    const cost = elapsed(() => {
      pasted = pasteSheetClipboardPayload(document, worksheet.id, { row: 500, column: 0 }, payload);
    });

    expect(pasted.worksheets[0].cells['r501:c1']).toBeDefined();
    expect(cost).toBeLessThan(sheetTimeBudget('pasteTenThousandCellsMs'));
  });

  it('writes 10,000 cells in one batch without copying the sheet per cell', () => {
    const document = createSparseWorkbookFixture();
    const worksheet = document.worksheets[0];
    const writes: SheetCellWrite[] = [];
    for (let row = 0; row < 100; row += 1) {
      for (let column = 0; column < 100; column += 1) {
        writes.push({
          position: { row: 2_000 + row, column },
          cell: { value: row * column, valueType: 'number' },
        });
      }
    }

    let next = document;
    const cost = elapsed(() => {
      next = setCells(document, worksheet.id, writes);
    });

    expect(Object.keys(next.worksheets[0].cells)).toHaveLength(110_000);
    expect(cost).toBeLessThan(sheetTimeBudget('pasteTenThousandCellsMs'));
  });
});
