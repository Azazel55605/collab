import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import {
  applySheetConditionalFormat,
  createConditionalFormatEvaluator,
  removeSheetConditionalFormat,
} from './conditionalFormatting';
import { activeWorksheet, deleteTracks, duplicateWorksheet, setCell } from './operations';
import { createSelection, extendSelection } from './selection';

function fixture() {
  let document = createEmptySheetDocument('Conditions', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 6, columns: 4 },
  });
  const worksheet = activeWorksheet(document);
  [1, 2, 2, 4].forEach((value, row) => {
    document = setCell(document, worksheet.id, { row, column: 0 }, {
      value,
      valueType: 'number',
    });
  });
  return document;
}

function dataSelection() {
  return extendSelection(createSelection({ row: 0, column: 0 }), { row: 3, column: 0 });
}

describe('sheet conditional formatting', () => {
  it('applies comparison styles without mutating base cell formatting', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'comparison',
      operator: 'greater',
      values: [1],
      style: { backgroundColor: '#fee2e2', bold: true },
    });
    const formatted = activeWorksheet(document);
    const evaluate = createConditionalFormatEvaluator(document.styles, formatted);
    expect(evaluate({ row: 0, column: 0 })).toEqual({});
    expect(evaluate({ row: 1, column: 0 })).toMatchObject({
      backgroundColor: '#fee2e2',
      bold: true,
    });
    expect(formatted.cells[`${formatted.rowOrder[1]}:${formatted.columnOrder[0]}`].styleId)
      .toBeUndefined();
  });

  it('distinguishes duplicate and unique non-blank values', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'duplicateValues',
      style: { backgroundColor: '#fecaca' },
    });
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'uniqueValues',
      style: { color: '#166534' },
    });
    const formatted = activeWorksheet(document);
    const evaluate = createConditionalFormatEvaluator(document.styles, formatted);
    expect(evaluate({ row: 1, column: 0 }).backgroundColor).toBe('#fecaca');
    expect(evaluate({ row: 2, column: 0 }).backgroundColor).toBe('#fecaca');
    expect(evaluate({ row: 0, column: 0 }).color).toBe('#166534');
    expect(evaluate({ row: 3, column: 0 }).color).toBe('#166534');
  });

  it('interpolates numeric color scales across the selected range', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'colorScale',
      colorScale: [
        { position: 0, color: '#ff0000' },
        { position: 1, color: '#00ff00' },
      ],
    });
    const evaluate = createConditionalFormatEvaluator(document.styles, activeWorksheet(document));
    expect(evaluate({ row: 0, column: 0 }).backgroundColor).toBe('rgb(255, 0, 0)');
    expect(evaluate({ row: 3, column: 0 }).backgroundColor).toBe('rgb(0, 255, 0)');
  });

  it('removes rules and prunes styles that no longer have references', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'comparison',
      operator: 'greater',
      values: [1],
      style: { backgroundColor: '#fee2e2' },
    });
    const format = activeWorksheet(document).conditionalFormats![0];
    expect(format.styleId && document.styles[format.styleId]).toBeDefined();
    document = removeSheetConditionalFormat(document, worksheet.id, format.id);
    expect(activeWorksheet(document).conditionalFormats).toBeUndefined();
    expect(Object.keys(document.styles)).toHaveLength(0);
  });

  it('repairs ranges after deletion and remaps them during duplication', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(document, worksheet.id, dataSelection(), {
      kind: 'duplicateValues',
      style: { backgroundColor: '#fecaca' },
    });
    worksheet = activeWorksheet(document);
    const nextStart = worksheet.rowOrder[1];
    const originalId = worksheet.conditionalFormats![0].id;
    document = deleteTracks(document, worksheet.id, 'row', 0, 1);
    worksheet = activeWorksheet(document);
    expect(worksheet.conditionalFormats?.[0].ranges[0].startRowId).toBe(nextStart);

    document = duplicateWorksheet(document, worksheet.id);
    const copy = activeWorksheet(document);
    expect(copy.conditionalFormats?.[0].id).not.toBe(originalId);
    expect(copy.conditionalFormats?.[0].ranges[0].startRowId).toBe(copy.rowOrder[0]);
  });
});
