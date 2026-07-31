import { describe, expect, it } from 'vitest';

import { SHEET_LIMITS } from '../../types/sheet';
import {
  SheetDocumentError,
  countFormulaCells,
  countPopulatedCells,
  inspectSheetDocumentText,
  normalizeSheetDocument,
  parseSheetDocument,
  serializeSheetDocument,
} from './document';
import {
  CORRUPT_SHEET_FIXTURES,
  SHEET_SHAPE_FIXTURES,
  createDeepDependencyWorkbookFixture,
  createDenseWorkbookFixture,
  createHighlyFormattedWorkbookFixture,
  createTallWorkbookFixture,
  createWideWorkbookFixture,
} from './fixture';
import type { SheetFixtureShape } from './fixture';

const shapes = Object.keys(SHEET_SHAPE_FIXTURES) as SheetFixtureShape[];

describe('Phase 9 workbook shape fixtures', () => {
  it.each(shapes)('%s round-trips through the document boundary', (shape) => {
    const built = SHEET_SHAPE_FIXTURES[shape]();
    const inspection = normalizeSheetDocument(built);

    expect(inspection.support).toBe('supported');
    // A fixture that needs repairs is a broken fixture, not a valid test input.
    expect(inspection.warnings).toEqual([]);

    const reparsed = parseSheetDocument(serializeSheetDocument(inspection.document));
    expect(countPopulatedCells(reparsed)).toBe(countPopulatedCells(inspection.document));
    expect(reparsed.worksheets[0].rowOrder).toHaveLength(built.worksheets[0].rowOrder.length);
  });

  it.each(shapes)('%s stays inside the published structural limits', (shape) => {
    const document = SHEET_SHAPE_FIXTURES[shape]();
    expect(document.worksheets.length).toBeLessThanOrEqual(SHEET_LIMITS.worksheetsPerWorkbook);
    expect(countPopulatedCells(document)).toBeLessThanOrEqual(
      SHEET_LIMITS.populatedCellsPerWorkbook,
    );
    expect(countFormulaCells(document)).toBeLessThanOrEqual(SHEET_LIMITS.formulaCellsPerWorkbook);
    for (const worksheet of document.worksheets) {
      expect(worksheet.rowOrder.length).toBeLessThanOrEqual(SHEET_LIMITS.rowsPerWorksheet);
      expect(worksheet.columnOrder.length).toBeLessThanOrEqual(SHEET_LIMITS.columnsPerWorksheet);
      expect(Object.keys(worksheet.cells).length).toBeLessThanOrEqual(
        SHEET_LIMITS.populatedCellsPerWorksheet,
      );
    }
  });

  it('covers each stress axis it claims to', () => {
    const dense = createDenseWorkbookFixture(20, 10);
    // Dense means every cell of the grid is populated.
    expect(Object.keys(dense.worksheets[0].cells)).toHaveLength(200);

    const wide = createWideWorkbookFixture(1_000, 4);
    expect(wide.worksheets[0].columnOrder.length).toBeGreaterThan(
      wide.worksheets[0].rowOrder.length * 100,
    );

    const tall = createTallWorkbookFixture(50_000);
    expect(tall.worksheets[0].rowOrder.length).toBeGreaterThan(
      tall.worksheets[0].columnOrder.length * 1_000,
    );

    const chain = createDeepDependencyWorkbookFixture(500);
    expect(countFormulaCells(chain)).toBe(499);
    expect(chain.worksheets[0].cells['r500:c1'].formula).toBe('=A499+1');

    const formatted = createHighlyFormattedWorkbookFixture(60, 10, 8);
    // Styles are shared through the workbook style table, not inlined per cell.
    expect(Object.keys(formatted.styles)).toHaveLength(8);
    expect(Object.keys(formatted.worksheets[0].cells)).toHaveLength(600);
    expect(formatted.worksheets[0].conditionalFormats).toHaveLength(15);
    expect(formatted.worksheets[0].mergedRanges).toHaveLength(7);
  });
});

describe('corrupted workbooks fail safely', () => {
  it.each(CORRUPT_SHEET_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      if (fixture.outcome.kind === 'rejected') {
        let thrown: unknown;
        try {
          inspectSheetDocumentText(fixture.text);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(SheetDocumentError);
        expect((thrown as SheetDocumentError).code).toBe(fixture.outcome.code);
        // The message is user-facing; it must not paste the stored content back.
        expect((thrown as SheetDocumentError).message.length).toBeLessThan(400);
        expect((thrown as SheetDocumentError).message).not.toContain(fixture.text.slice(0, 40));
        return;
      }

      // A recoverable defect opens, but the repair must be reported rather than
      // silently rewriting what the user stored.
      const inspection = inspectSheetDocumentText(fixture.text);
      expect(inspection.warnings.join('\n')).toMatch(fixture.outcome.warning);
      expect(inspection.document.worksheets.length).toBeGreaterThan(0);
      // Whatever survived must itself be a valid workbook.
      expect(normalizeSheetDocument(inspection.document).warnings).toEqual([]);
    },
  );

  it('treats an empty file as a new workbook rather than an error', () => {
    // A `.sheet` that was created but never written is not corruption.
    const inspection = inspectSheetDocumentText('', 'Budget');
    expect(inspection.warnings).toEqual([]);
    expect(inspection.document.name).toBe('Budget');
    expect(inspection.document.worksheets).toHaveLength(1);
  });

  it('refuses to edit a workbook written by a newer schema', () => {
    const newer = JSON.stringify({
      ...JSON.parse(serializeSheetDocument(SHEET_SHAPE_FIXTURES.dense())),
      schemaVersion: 99,
    });
    expect(inspectSheetDocumentText(newer).support).toBe('newer');
    expect(() => parseSheetDocument(newer)).toThrow(SheetDocumentError);
  });
});
