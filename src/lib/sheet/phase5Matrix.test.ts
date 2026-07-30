import { describe, expect, it } from 'vitest';

import { createSheetTable, setSheetTableColumnFilter, sortSheetTable } from './dataTools';
import { createEmptySheetDocument } from './document';
import { enforceSheetMutationPolicies } from './mutationPolicy';
import {
  activeWorksheet,
  getCell,
  mergeSelection,
  setCell,
} from './operations';
import { createSelection, extendSelection } from './selection';
import { applySheetValidation } from './validation';

describe('Phase 5 combined data-tool matrix', () => {
  it('keeps formulas, merges, validation, filters, and stable identities coherent during sort', () => {
    let document = createEmptySheetDocument('Matrix', {
      worksheet: { rows: 6, columns: 4 },
    });
    let worksheet = activeWorksheet(document);
    const rows = [
      ['Name', 'Score'],
      ['Beta', 2],
      ['Alpha', 1],
      ['Gamma', 3],
    ] as const;
    for (const [row, values] of rows.entries()) {
      for (const [column, value] of values.entries()) {
        document = setCell(document, worksheet.id, { row, column }, {
          value,
          valueType: typeof value === 'number' ? 'number' : 'text',
        });
      }
      if (row > 0) {
        document = setCell(document, worksheet.id, { row, column: 2 }, {
          formula: `=B${row + 1}*2`,
        });
      }
    }
    document = applySheetValidation(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 1, column: 1 }), { row: 3, column: 1 }),
      { kind: 'number', min: 0, strict: true },
    );
    document = createSheetTable(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 3, column: 2 }),
      'Scores',
    );
    document = mergeSelection(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 4, column: 2 }), { row: 5, column: 3 }),
    );
    worksheet = activeWorksheet(document);
    const table = worksheet.tables![0];
    document = setSheetTableColumnFilter(
      document,
      worksheet.id,
      table.id,
      table.columns[1].columnId,
      { columnId: table.columns[1].columnId, numberMin: 2 },
    );
    const before = document;
    const sorted = sortSheetTable(
      document,
      worksheet.id,
      table.id,
      [{ columnId: table.columns[0].columnId, direction: 'ascending' }],
    );
    const result = enforceSheetMutationPolicies(before, sorted).document;
    worksheet = activeWorksheet(result);
    expect(getCell(worksheet, { row: 1, column: 0 })?.value).toBe('Alpha');
    expect(getCell(worksheet, { row: 1, column: 2 })?.formula).toBe('=B2*2');
    expect(getCell(worksheet, { row: 1, column: 1 })?.validationId).toBeTruthy();
    expect(worksheet.mergedRanges).toEqual(activeWorksheet(before).mergedRanges);
    expect(worksheet.rowOrder).toEqual(activeWorksheet(before).rowOrder);
    expect(activeWorksheet(before).cells).not.toEqual(worksheet.cells);
  });
});
