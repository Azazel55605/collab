import { describe, expect, it } from 'vitest';

import { sheetFormulaResultKey } from '../../types/sheetFormula';
import { applySheetConditionalFormat, createConditionalFormatEvaluator } from './conditionalFormatting';
import { createEmptySheetDocument } from './document';
import {
  buildSheetRuleFormulaInputs,
  conditionalFormulaExpressionId,
} from './formulaRules';
import { activeWorksheet, setCell } from './operations';
import { createSelection, extendSelection } from './selection';

describe('sheet rule formula runtime', () => {
  it('builds bounded native formula inputs with relative references', () => {
    let document = createEmptySheetDocument('Rules', {
      worksheet: { name: 'Input Data', rows: 4, columns: 2 },
    });
    const worksheet = activeWorksheet(document);
    document = applySheetConditionalFormat(
      document,
      worksheet.id,
      extendSelection(createSelection({ row: 0, column: 0 }), { row: 1, column: 0 }),
      { kind: 'formula', formula: '=A1>0', style: { bold: true } },
    );
    const inputs = buildSheetRuleFormulaInputs(document);
    expect(inputs.worksheets).toHaveLength(1);
    expect(inputs.cells.map((cell) => cell.formula)).toEqual([
      "='Input Data'!A1>0",
      "='Input Data'!A2>0",
    ]);
  });

  it('uses native boolean results to resolve formula formatting', () => {
    let document = createEmptySheetDocument('Rules', { worksheet: { rows: 2, columns: 1 } });
    let worksheet = activeWorksheet(document);
    document = setCell(document, worksheet.id, { row: 0, column: 0 }, {
      value: 2,
      valueType: 'number',
    });
    document = applySheetConditionalFormat(
      document,
      worksheet.id,
      createSelection({ row: 0, column: 0 }),
      { kind: 'formula', formula: '=A1>0', style: { bold: true } },
    );
    worksheet = activeWorksheet(document);
    const rule = worksheet.conditionalFormats![0];
    const expressionId = conditionalFormulaExpressionId(rule.id, worksheet, { row: 0, column: 0 });
    const values = new Map([[
      sheetFormulaResultKey(`__collab_rules__:${worksheet.id}`, expressionId, 'result'),
      { type: 'boolean' as const, value: true },
    ]]);
    expect(createConditionalFormatEvaluator(document.styles, worksheet, values)({
      row: 0,
      column: 0,
    }).bold).toBe(true);
  });
});
