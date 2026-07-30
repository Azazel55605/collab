import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { createSheetClipboardPayload } from './clipboard';
import {
  activeWorksheet,
  deleteTracks,
  duplicateWorksheet,
  getCell,
  setCell,
} from './operations';
import { createSelection, extendSelection } from './selection';
import {
  applySheetValidation,
  clearSheetValidation,
  setValidatedCell,
  validateCellAgainstValidation,
  validationAt,
} from './validation';

function fixture() {
  return createEmptySheetDocument('Validation', {
    timestamp: '2026-07-30T00:00:00.000Z',
    worksheet: { rows: 6, columns: 4 },
  });
}

describe('sheet data validation', () => {
  it('assigns one reusable rule to a selection and prunes it when cleared', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    const selection = extendSelection(
      createSelection({ row: 0, column: 0 }),
      { row: 1, column: 1 },
    );
    document = applySheetValidation(document, worksheet.id, selection, {
      kind: 'list',
      options: ['Open', 'Done'],
      strict: true,
    });
    const validated = activeWorksheet(document);
    expect(validated.validations).toHaveLength(1);
    expect(getCell(validated, { row: 0, column: 0 })?.validationId)
      .toBe(validated.validations?.[0].id);
    expect(getCell(validated, { row: 1, column: 1 })?.validationId)
      .toBe(validated.validations?.[0].id);

    document = clearSheetValidation(document, worksheet.id, selection);
    expect(activeWorksheet(document).validations).toBeUndefined();
    expect(getCell(activeWorksheet(document), { row: 0, column: 0 })).toBeUndefined();
  });

  it('enforces strict rules and permits warning-only rules', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetValidation(document, worksheet.id, createSelection({ row: 0, column: 0 }), {
      kind: 'number',
      min: 1,
      max: 10,
      strict: true,
      message: 'Use a value from 1 to 10.',
    });
    expect(() => setValidatedCell(document, worksheet.id, { row: 0, column: 0 }, {
      value: 20,
      valueType: 'number',
    })).toThrowError(/1 to 10/);

    document = applySheetValidation(document, worksheet.id, createSelection({ row: 0, column: 1 }), {
      kind: 'text',
      max: 3,
      strict: false,
    });
    const result = setValidatedCell(document, worksheet.id, { row: 0, column: 1 }, {
      value: 'long',
      valueType: 'text',
    });
    expect(result.warning).toMatch(/no more than 3/);
    expect(getCell(activeWorksheet(result.document), { row: 0, column: 1 })?.value).toBe('long');
  });

  it('validates literal lists, source ranges, dates, and text lengths', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 3, column: 0 }, {
      value: 'Red',
      valueType: 'text',
    });
    worksheet = activeWorksheet(document);
    const sourceRange = {
      startRowId: worksheet.rowOrder[3],
      endRowId: worksheet.rowOrder[3],
      startColumnId: worksheet.columnOrder[0],
      endColumnId: worksheet.columnOrder[0],
    };
    expect(validateCellAgainstValidation(worksheet, {
      id: 'list',
      kind: 'list',
      options: ['Red', 'Blue'],
    }, { value: 'Blue', valueType: 'text' }).valid).toBe(true);
    expect(validateCellAgainstValidation(worksheet, {
      id: 'range',
      kind: 'range',
      sourceRange,
    }, { value: 'Blue', valueType: 'text' }).valid).toBe(false);
    expect(validateCellAgainstValidation(worksheet, {
      id: 'date',
      kind: 'date',
      min: '2026-01-01',
      max: '2026-12-31',
    }, { value: '2026-07-30', valueType: 'date' }).valid).toBe(true);
    expect(validateCellAgainstValidation(worksheet, {
      id: 'text',
      kind: 'text',
      min: 2,
      max: 5,
    }, { value: 'x', valueType: 'text' }).valid).toBe(false);
  });

  it('keeps destination validation out of copied cell payload semantics', () => {
    let document = fixture();
    const worksheet = activeWorksheet(document);
    document = applySheetValidation(document, worksheet.id, createSelection({ row: 0, column: 0 }), {
      kind: 'list',
      options: ['A'],
    });
    expect(validationAt(activeWorksheet(document), { row: 0, column: 0 })?.kind).toBe('list');
    const payload = createSheetClipboardPayload(
      document,
      activeWorksheet(document),
      createSelection({ row: 0, column: 0 }),
    );
    expect(payload.cells[0][0]?.cell?.validationId).toBeUndefined();
  });

  it('repairs source ranges on deletion and remaps identities on worksheet duplication', () => {
    let document = fixture();
    let worksheet = activeWorksheet(document);
    const sourceRange = {
      startRowId: worksheet.rowOrder[2],
      endRowId: worksheet.rowOrder[4],
      startColumnId: worksheet.columnOrder[0],
      endColumnId: worksheet.columnOrder[0],
    };
    const nextSourceStart = worksheet.rowOrder[3];
    document = applySheetValidation(document, worksheet.id, createSelection({ row: 0, column: 0 }), {
      kind: 'range',
      sourceRange,
    });
    worksheet = activeWorksheet(document);
    const originalId = worksheet.validations![0].id;

    document = deleteTracks(document, worksheet.id, 'row', 2, 1);
    worksheet = activeWorksheet(document);
    expect(worksheet.validations?.[0].sourceRange?.startRowId).toBe(nextSourceStart);

    document = duplicateWorksheet(document, worksheet.id);
    const copy = activeWorksheet(document);
    expect(copy.validations?.[0].id).not.toBe(originalId);
    expect(copy.validations?.[0].sourceRange?.startRowId).toBe(copy.rowOrder[2]);
    expect(getCell(copy, { row: 0, column: 0 })?.validationId).toBe(copy.validations?.[0].id);
  });
});
