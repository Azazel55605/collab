import { describe, expect, it } from 'vitest';

import { createSheetClipboardPayload, pasteSheetClipboardPayload } from './clipboard';
import { createEmptySheetDocument } from './document';
import { enforceSheetMutationPolicies } from './mutationPolicy';
import { activeWorksheet, getCell, setCell } from './operations';
import { createSelection } from './selection';
import { applySheetValidation } from './validation';

describe('sheet mutation policies', () => {
  it('enforces destination validation during paste and preserves its identity', () => {
    let document = createEmptySheetDocument('Policy', { worksheet: { rows: 3, columns: 2 } });
    let worksheet = activeWorksheet(document);
    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 0 },
      {
        value: 20,
        valueType: 'number',
      },
    );
    document = applySheetValidation(
      document,
      worksheet.id,
      createSelection({ row: 1, column: 0 }),
      { kind: 'number', min: 1, max: 10, strict: true },
    );
    worksheet = activeWorksheet(document);
    const payload = createSheetClipboardPayload(
      document,
      worksheet,
      createSelection({ row: 0, column: 0 }),
    );
    const pasted = pasteSheetClipboardPayload(
      document,
      worksheet.id,
      { row: 1, column: 0 },
      payload,
    );
    expect(() => enforceSheetMutationPolicies(document, pasted)).toThrowError(/less than or equal/);

    document = setCell(
      document,
      worksheet.id,
      { row: 0, column: 0 },
      {
        value: 5,
        valueType: 'number',
      },
    );
    worksheet = activeWorksheet(document);
    const validPayload = createSheetClipboardPayload(
      document,
      worksheet,
      createSelection({ row: 0, column: 0 }),
    );
    const validPaste = pasteSheetClipboardPayload(
      document,
      worksheet.id,
      { row: 1, column: 0 },
      validPayload,
    );
    const result = enforceSheetMutationPolicies(document, validPaste).document;
    expect(getCell(activeWorksheet(result), { row: 1, column: 0 })?.validationId).toBeTruthy();
  });
});
