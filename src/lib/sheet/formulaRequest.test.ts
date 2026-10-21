import { expect, it } from 'vitest';

import { sheetAddressIndex } from './address';
import { createWorkbookFixture } from './fixture';
import { buildSheetFormulaRequest } from './formulaRequest';
import { setCell } from './operations';

it('reuses stable cell inputs and structural positions across value/style changes', () => {
  const doc = createWorkbookFixture({
    rows: 1000,
    columns: 20,
    populatedRows: 1000,
    populatedColumns: 10,
    formulaColumn: true,
  });
  const first = buildSheetFormulaRequest(doc, 'id', 'UTC');
  const ws = doc.worksheets[0];
  const next = setCell(doc, ws.id, { row: 0, column: 0 }, { value: 42, valueType: 'number' });
  const second = buildSheetFormulaRequest(next, 'id', 'UTC');
  expect(second.structureSignature).toBe(first.structureSignature);
  expect(second.cells.filter((cell, i) => cell === first.cells[i]).length).toBe(
    first.cells.length - 1,
  );
  expect(sheetAddressIndex(next.worksheets[0])).toBe(sheetAddressIndex(ws));
  const structural = {
    ...next,
    worksheets: [{ ...next.worksheets[0], rowOrder: [...ws.rowOrder].reverse() }],
  };
  expect(buildSheetFormulaRequest(structural, 'id', 'UTC').structureSignature).not.toBe(
    first.structureSignature,
  );
  expect(sheetAddressIndex(structural.worksheets[0])).not.toBe(sheetAddressIndex(ws));
});
