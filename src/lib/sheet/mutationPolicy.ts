import type { SheetCell, SheetDocument } from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetCellKey } from '../../types/sheet';
import { SheetDocumentError } from './document';
import { assertProtectedRangesUnchanged } from './protectedRanges';
import { validateCellAgainstValidation } from './validation';

function content(cell: SheetCell | undefined): SheetCell | undefined {
  if (!cell) return undefined;
  const { validationId: _validationId, ...rest } = cell;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function enforceSheetMutationPolicies(
  before: SheetDocument,
  after: SheetDocument,
  computedValues?: SheetFormulaValueMap,
  options: { allowProtectionChange?: boolean } = {},
): { document: SheetDocument; warnings: string[] } {
  if (!options.allowProtectionChange) assertProtectedRangesUnchanged(before, after);
  const warnings: string[] = [];
  let document = after;
  for (const source of before.worksheets) {
    const target = document.worksheets.find((worksheet) => worksheet.id === source.id);
    if (!target) continue;
    const cells = { ...target.cells };
    let changed = false;
    const keys = new Set([...Object.keys(source.cells), ...Object.keys(target.cells)]);
    for (const key of keys) {
      const previous = source.cells[key];
      const candidate = target.cells[key];
      if (JSON.stringify(content(previous)) === JSON.stringify(content(candidate))) continue;
      const validationId = previous?.validationId;
      if (!validationId) continue;
      const validation = source.validations?.find((rule) => rule.id === validationId);
      if (!validation) continue;
      const [rowId, columnId] = key.split(':');
      const position = {
        row: target.rowOrder.indexOf(rowId),
        column: target.columnOrder.indexOf(columnId),
      };
      if (position.row < 0 || position.column < 0) continue;
      const repaired = candidate
        ? { ...candidate, validationId }
        : { validationId };
      const result = validateCellAgainstValidation(
        target,
        validation,
        repaired,
        position,
        validation.kind === 'custom' ? undefined : computedValues,
      );
      if (!result.valid && validation.strict !== false) {
        throw new SheetDocumentError('invalid-structure', result.message ?? 'The value is not valid.');
      }
      if (!result.valid && result.message) warnings.push(result.message);
      cells[sheetCellKey(rowId, columnId)] = repaired;
      changed = true;
    }
    if (changed) {
      document = {
        ...document,
        worksheets: document.worksheets.map((worksheet) => (
          worksheet.id === target.id ? { ...target, cells } : worksheet
        )),
      };
    }
  }
  return { document, warnings: [...new Set(warnings)] };
}
