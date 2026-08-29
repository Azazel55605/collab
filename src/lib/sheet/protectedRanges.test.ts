import { describe, expect, it } from 'vitest';

import { createEmptySheetDocument } from './document';
import { enforceSheetMutationPolicies } from './mutationPolicy';
import { activeWorksheet, insertTracks, setCell } from './operations';
import { protectSheetSelection, removeSheetProtection } from './protectedRanges';
import { createSelection, extendSelection } from './selection';

describe('sheet protected ranges', () => {
  it('blocks cell and intersecting structural edits until protection is removed', () => {
    let document = createEmptySheetDocument('Protected', { worksheet: { rows: 3, columns: 3 } });
    const worksheet = activeWorksheet(document);
    document = protectSheetSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 0, column: 1 }), { row: 2, column: 1 }),
      'Approved total',
    );
    const edited = setCell(
      document,
      worksheet.id,
      { row: 1, column: 1 },
      {
        value: 2,
        valueType: 'number',
      },
    );
    expect(() => enforceSheetMutationPolicies(document, edited)).toThrowError(/protected range/);
    const inserted = insertTracks(document, worksheet.id, 'row', 1, 1);
    expect(() => enforceSheetMutationPolicies(document, inserted)).toThrowError(/structural edit/);

    const protectionId = activeWorksheet(document).protectedRanges![0].id;
    document = removeSheetProtection(document, worksheet.id, protectionId);
    expect(() =>
      enforceSheetMutationPolicies(
        document,
        setCell(document, worksheet.id, { row: 1, column: 1 }, { value: 2, valueType: 'number' }),
      ),
    ).not.toThrow();
  });
});
