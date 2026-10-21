import type { SheetDocument, SheetRange, SheetValidation, SheetWorksheet } from '../../types/sheet';
import type {
  SheetFormulaCellInput,
  SheetFormulaComputedValue,
  SheetFormulaValueMap,
  SheetFormulaWorksheetInput,
} from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';

import { sheetAddressIndex } from './address';
import type { SheetPosition } from './address';
import { parseFormulaReferences, translateFormulaReferences } from './formulaReferences';
import { expandNamedRangesInFormula } from './namedRanges';

const MAX_RULE_FORMULAS = 50_000;
const RULE_SHEET_PREFIX = '__collab_rules__';

function syntheticWorksheetId(worksheetId: string): string {
  return `${RULE_SHEET_PREFIX}:${worksheetId}`;
}

function quoteWorksheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;
}

function qualifyLocalReferences(formula: string, worksheetName: string): string {
  const references = parseFormulaReferences(formula);
  let result = formula;
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index];
    if (reference.sheetName) continue;
    result = `${result.slice(0, reference.start)}${quoteWorksheet(worksheetName)}${reference.source}${result.slice(reference.end)}`;
  }
  return result;
}

function bounds(worksheet: SheetWorksheet, range: SheetRange) {
  const rows = [
    sheetAddressIndex(worksheet).rowIndexOf(range.startRowId) ?? -1,
    sheetAddressIndex(worksheet).rowIndexOf(range.endRowId) ?? -1,
  ];
  const columns = [
    sheetAddressIndex(worksheet).columnIndexOf(range.startColumnId) ?? -1,
    sheetAddressIndex(worksheet).columnIndexOf(range.endColumnId) ?? -1,
  ];
  if ([...rows, ...columns].some((value) => value < 0)) return null;
  return {
    top: Math.min(...rows),
    bottom: Math.max(...rows),
    left: Math.min(...columns),
    right: Math.max(...columns),
  };
}

function translatedFormula(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  formula: string,
  anchor: SheetPosition,
  position: SheetPosition,
): string {
  const expanded = expandNamedRangesInFormula(document, worksheet.id, formula);
  return qualifyLocalReferences(
    translateFormulaReferences(
      expanded,
      position.row - anchor.row,
      position.column - anchor.column,
    ),
    worksheet.name,
  );
}

export function conditionalFormulaExpressionId(
  ruleId: string,
  worksheet: SheetWorksheet,
  position: SheetPosition,
): string {
  return `condition:${ruleId}:${worksheet.rowOrder[position.row]}:${worksheet.columnOrder[position.column]}`;
}

export function validationFormulaExpressionId(
  validationId: string,
  worksheet: SheetWorksheet,
  position: SheetPosition,
): string {
  return `validation:${validationId}:${worksheet.rowOrder[position.row]}:${worksheet.columnOrder[position.column]}`;
}

export function ruleFormulaValue(
  values: SheetFormulaValueMap | undefined,
  worksheet: SheetWorksheet,
  expressionId: string,
): SheetFormulaComputedValue | undefined {
  return values?.get(
    sheetFormulaResultKey(syntheticWorksheetId(worksheet.id), expressionId, 'result'),
  );
}

function validationAnchor(
  worksheet: SheetWorksheet,
  validation: SheetValidation,
): SheetPosition | null {
  if (!validation.anchor) return null;
  const row = sheetAddressIndex(worksheet).rowIndexOf(validation.anchor.rowId) ?? -1;
  const column = sheetAddressIndex(worksheet).columnIndexOf(validation.anchor.columnId) ?? -1;
  return row >= 0 && column >= 0 ? { row, column } : null;
}

export function buildSheetRuleFormulaInputs(document: SheetDocument): {
  worksheets: SheetFormulaWorksheetInput[];
  cells: SheetFormulaCellInput[];
} {
  const worksheets: SheetFormulaWorksheetInput[] = [];
  const cells: SheetFormulaCellInput[] = [];
  const usedWorksheetNames = new Set(
    document.worksheets.map((worksheet) => worksheet.name.toLocaleLowerCase()),
  );
  for (const [worksheetIndex, worksheet] of document.worksheets.entries()) {
    let syntheticRow = 1;
    const add = (expressionId: string, formula: string) => {
      if (cells.length >= MAX_RULE_FORMULAS) return;
      cells.push({
        worksheetId: syntheticWorksheetId(worksheet.id),
        rowId: expressionId,
        columnId: 'result',
        row: syntheticRow,
        column: 1,
        formula,
      });
      syntheticRow += 1;
    };

    for (const rule of worksheet.conditionalFormats ?? []) {
      if (rule.kind !== 'formula' || !rule.formula) continue;
      const origin = rule.ranges[0] ? bounds(worksheet, rule.ranges[0]) : null;
      if (!origin) continue;
      for (const range of rule.ranges) {
        const rectangle = bounds(worksheet, range);
        if (!rectangle) continue;
        for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
          for (let column = rectangle.left; column <= rectangle.right; column += 1) {
            const position = { row, column };
            add(
              conditionalFormulaExpressionId(rule.id, worksheet, position),
              translatedFormula(
                document,
                worksheet,
                rule.formula,
                { row: origin.top, column: origin.left },
                position,
              ),
            );
          }
        }
      }
    }

    const customValidations = new Map(
      worksheet.validations
        ?.filter((rule) => rule.kind === 'custom')
        .map((rule) => [rule.id, rule]),
    );
    for (const [key, cell] of customValidations.size ? Object.entries(worksheet.cells) : []) {
      const validation = cell.validationId ? customValidations.get(cell.validationId) : undefined;
      if (validation?.kind !== 'custom' || !validation.formula) continue;
      const [rowId, columnId] = key.split(':');
      const position = {
        row: sheetAddressIndex(worksheet).rowIndexOf(rowId) ?? -1,
        column: sheetAddressIndex(worksheet).columnIndexOf(columnId) ?? -1,
      };
      if (position.row < 0 || position.column < 0) continue;
      add(
        validationFormulaExpressionId(validation.id, worksheet, position),
        translatedFormula(
          document,
          worksheet,
          validation.formula,
          validationAnchor(worksheet, validation) ?? position,
          position,
        ),
      );
    }

    if (syntheticRow > 1) {
      let name = `__CollabRules${worksheetIndex + 1}`;
      while (usedWorksheetNames.has(name.toLocaleLowerCase())) name = `_${name}`;
      usedWorksheetNames.add(name.toLocaleLowerCase());
      worksheets.push({
        id: syntheticWorksheetId(worksheet.id),
        name,
      });
    }
  }
  return { worksheets, cells };
}
