import type { SheetDocument } from '../../types/sheet';
import type { SheetFormulaEvaluationRequest } from '../../types/sheetFormula';

import { buildSheetRuleFormulaInputs } from './formulaRules';
import { expandNamedRangesInFormula } from './namedRanges';

export function buildSheetFormulaRequest(
  document: SheetDocument,
  id: string,
  timeZone: string,
  evaluationTime = new Date().toISOString(),
): SheetFormulaEvaluationRequest {
  const ruleInputs = buildSheetRuleFormulaInputs(document);
  const worksheets = [
    ...document.worksheets.map((worksheet) => ({
      id: worksheet.id,
      name: worksheet.name,
    })),
    ...ruleInputs.worksheets,
  ];
  const cells = [
    ...document.worksheets.flatMap((worksheet) => {
      const rowPositions = new Map(worksheet.rowOrder.map((rowId, index) => [rowId, index + 1]));
      const columnPositions = new Map(
        worksheet.columnOrder.map((columnId, index) => [columnId, index + 1]),
      );
      return Object.entries(worksheet.cells).flatMap(([key, cell]) => {
        const separator = key.indexOf(':');
        const rowId = key.slice(0, separator);
        const columnId = key.slice(separator + 1);
        const row = rowPositions.get(rowId);
        const column = columnPositions.get(columnId);
        if (!row || !column) return [];
        return [
          {
            worksheetId: worksheet.id,
            rowId,
            columnId,
            row,
            column,
            ...(cell.formula
              ? { formula: expandNamedRangesInFormula(document, worksheet.id, cell.formula) }
              : {}),
            ...(cell.valueType ? { valueType: cell.valueType } : {}),
            ...(cell.value !== undefined ? { value: cell.value } : {}),
          },
        ];
      });
    }),
    ...ruleInputs.cells,
  ];
  const structureSignature = JSON.stringify([
    document.worksheets.map((worksheet) => [
      worksheet.id,
      worksheet.name,
      worksheet.rowOrder,
      worksheet.columnOrder,
      worksheet.validations ?? [],
      worksheet.conditionalFormats ?? [],
    ]),
    document.namedRanges ?? [],
  ]);
  return {
    runtimeId: id,
    structureSignature,
    worksheets,
    cells,
    evaluationTime,
    timeZone,
  };
}

export function hasSheetFormulas(document: SheetDocument): boolean {
  return document.worksheets.some(
    (worksheet) =>
      Object.values(worksheet.cells).some((cell) => Boolean(cell.formula)) ||
      worksheet.conditionalFormats?.some((rule) => rule.kind === 'formula') ||
      worksheet.validations?.some((rule) => rule.kind === 'custom'),
  );
}
