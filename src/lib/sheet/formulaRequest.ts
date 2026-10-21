import type { SheetCell, SheetDocument } from '../../types/sheet';
import type {
  SheetFormulaCellInput,
  SheetFormulaEvaluationRequest,
} from '../../types/sheetFormula';

import { sheetAddressIndex } from './address';
import { buildSheetRuleFormulaInputs } from './formulaRules';
import { expandNamedRangesInFormula } from './namedRanges';

const identities = new WeakMap<object, number>();
let identity = 0;
function structuralId(value: object | undefined) {
  if (!value) return 0;
  let id = identities.get(value);
  if (!id) {
    id = ++identity;
    identities.set(value, id);
  }
  return id;
}
const inputs = new WeakMap<SheetCell, { scope: string; input: SheetFormulaCellInput }>();
const formulaPresence = new WeakMap<object, boolean>();

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
  const structureSignature = JSON.stringify([
    document.worksheets.map((worksheet) => [
      worksheet.id,
      worksheet.name,
      structuralId(worksheet.rowOrder),
      structuralId(worksheet.columnOrder),
      structuralId(worksheet.validations),
      structuralId(worksheet.conditionalFormats),
    ]),
    structuralId(document.namedRanges),
    ruleInputs.worksheets,
  ]);
  const cells = [
    ...document.worksheets.flatMap((worksheet) => {
      const index = sheetAddressIndex(worksheet);
      return Object.entries(worksheet.cells).flatMap(([key, cell]) => {
        const separator = key.indexOf(':');
        const rowId = key.slice(0, separator);
        const columnId = key.slice(separator + 1);
        const row = (index.rowIndexOf(rowId) ?? -1) + 1;
        const column = (index.columnIndexOf(columnId) ?? -1) + 1;
        if (!row || !column) return [];
        const scope = `${structureSignature}:${worksheet.id}:${key}`;
        const cached = inputs.get(cell);
        if (cached?.scope === scope) return [cached.input];
        const input: SheetFormulaCellInput = {
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
        };
        inputs.set(cell, { scope, input });
        return [input];
      });
    }),
    ...ruleInputs.cells,
  ];
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
  return document.worksheets.some((worksheet) => {
    let present = formulaPresence.get(worksheet);
    if (present === undefined) {
      present =
        Object.values(worksheet.cells).some((cell) => Boolean(cell.formula)) ||
        Boolean(worksheet.conditionalFormats?.some((rule) => rule.kind === 'formula')) ||
        Boolean(worksheet.validations?.some((rule) => rule.kind === 'custom'));
      formulaPresence.set(worksheet, present);
    }
    return present;
  });
}
