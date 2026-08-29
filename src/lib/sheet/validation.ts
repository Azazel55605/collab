import { SHEET_LIMITS, sheetCellKey } from '../../types/sheet';
import type {
  SheetCell,
  SheetDocument,
  SheetRange,
  SheetValidation,
  SheetWorksheet,
} from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';

import type { SheetPosition } from './address';
import { createSheetValidationId, SheetDocumentError } from './document';
import { ruleFormulaValue, validationFormulaExpressionId } from './formulaRules';
import { getCell, setCell } from './operations';
import { normalizeRange, selectedPositions, type SheetSelection } from './selection';

export type SheetValidationDraft = Omit<SheetValidation, 'id'>;

export interface SheetValidationResult {
  valid: boolean;
  message?: string;
  deferred?: boolean;
}

function compactValidation(validation: SheetValidationDraft): SheetValidationDraft {
  return Object.fromEntries(
    Object.entries(validation).filter(([, value]) => value !== undefined),
  ) as SheetValidationDraft;
}

export function validationAt(
  worksheet: SheetWorksheet,
  position: SheetPosition,
): SheetValidation | null {
  const validationId = getCell(worksheet, position)?.validationId;
  if (!validationId) return null;
  return worksheet.validations?.find((validation) => validation.id === validationId) ?? null;
}

export function applySheetValidation(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  draft: SheetValidationDraft,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  const positions = selectedPositions(selection);
  if (positions.length === 0) return document;
  if (positions.length > SHEET_LIMITS.populatedCellsPerWorksheet) {
    throw new SheetDocumentError('limit-exceeded', 'The validation selection is too large.');
  }
  if (draft.kind === 'custom' && positions.length > 10_000) {
    throw new SheetDocumentError(
      'limit-exceeded',
      'Custom-formula validation is limited to 10,000 cells per rule.',
    );
  }
  if ((worksheet.validations?.length ?? 0) >= SHEET_LIMITS.validationsPerWorksheet) {
    throw new SheetDocumentError(
      'limit-exceeded',
      `A worksheet may not have more than ${SHEET_LIMITS.validationsPerWorksheet} validation rules.`,
    );
  }
  const validation: SheetValidation = {
    id: createSheetValidationId(),
    ...compactValidation(draft),
    ...(draft.kind === 'custom'
      ? {
          anchor: {
            rowId: worksheet.rowOrder[selection.active.row],
            columnId: worksheet.columnOrder[selection.active.column],
          },
        }
      : {}),
  };
  let next = {
    ...document,
    worksheets: document.worksheets.map((candidate) =>
      candidate.id === worksheetId
        ? { ...candidate, validations: [...(candidate.validations ?? []), validation] }
        : candidate,
    ),
  };
  for (const position of positions) {
    const current = getCell(
      next.worksheets.find((candidate) => candidate.id === worksheetId)!,
      position,
    );
    next = setCell(next, worksheetId, position, {
      ...(current ?? {}),
      validationId: validation.id,
    });
  }
  return pruneUnusedValidations(next, worksheetId);
}

export function clearSheetValidation(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  const cells = { ...worksheet.cells };
  for (const position of selectedPositions(selection)) {
    const rowId = worksheet.rowOrder[position.row];
    const columnId = worksheet.columnOrder[position.column];
    if (!rowId || !columnId) continue;
    const key = sheetCellKey(rowId, columnId);
    const cell = cells[key];
    if (!cell?.validationId) continue;
    const next = { ...cell };
    delete next.validationId;
    if (Object.keys(next).length > 0) cells[key] = next;
    else delete cells[key];
  }
  return pruneUnusedValidations(
    {
      ...document,
      worksheets: document.worksheets.map((candidate) =>
        candidate.id === worksheetId ? { ...candidate, cells } : candidate,
      ),
    },
    worksheetId,
  );
}

function pruneUnusedValidations(document: SheetDocument, worksheetId: string): SheetDocument {
  return {
    ...document,
    worksheets: document.worksheets.map((worksheet) => {
      if (worksheet.id !== worksheetId || !worksheet.validations) return worksheet;
      const used = new Set(
        Object.values(worksheet.cells)
          .map((cell) => cell.validationId)
          .filter((id): id is string => Boolean(id)),
      );
      const validations = worksheet.validations.filter((validation) => used.has(validation.id));
      const next = { ...worksheet };
      if (validations.length > 0) next.validations = validations;
      else delete next.validations;
      return next;
    }),
  };
}

function valuesInRange(worksheet: SheetWorksheet, range: SheetRange): string[] {
  const top = worksheet.rowOrder.indexOf(range.startRowId);
  const bottom = worksheet.rowOrder.indexOf(range.endRowId);
  const left = worksheet.columnOrder.indexOf(range.startColumnId);
  const right = worksheet.columnOrder.indexOf(range.endColumnId);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return [];
  const values: string[] = [];
  for (let row = Math.min(top, bottom); row <= Math.max(top, bottom); row += 1) {
    for (let column = Math.min(left, right); column <= Math.max(left, right); column += 1) {
      const value = getCell(worksheet, { row, column })?.value;
      if (value !== undefined && value !== null) values.push(String(value));
    }
  }
  return values;
}

function failure(validation: SheetValidation, fallback: string): SheetValidationResult {
  return { valid: false, message: validation.message?.trim() || fallback };
}

export function validateCellAgainstValidation(
  worksheet: SheetWorksheet,
  validation: SheetValidation,
  cell: SheetCell | null,
  position?: SheetPosition,
  computedValues?: SheetFormulaValueMap,
): SheetValidationResult {
  if (!cell || (cell.value === undefined && !cell.formula) || cell.value === '')
    return { valid: true };
  if (validation.kind === 'custom') {
    if (!position) return { valid: true, deferred: true };
    const result = ruleFormulaValue(
      computedValues,
      worksheet,
      validationFormulaExpressionId(validation.id, worksheet, position),
    );
    if (!result) return { valid: true, deferred: true };
    const valid =
      result.type === 'boolean' ? result.value : result.type === 'number' && result.value !== 0;
    return valid ? { valid: true } : failure(validation, 'The custom formula rejected this value.');
  }
  if (cell.formula) return { valid: true };
  const value = cell.value;
  if (validation.kind === 'list') {
    return validation.options?.includes(String(value))
      ? { valid: true }
      : failure(validation, 'Choose a value from the validation list.');
  }
  if (validation.kind === 'range') {
    return validation.sourceRange &&
      valuesInRange(worksheet, validation.sourceRange).includes(String(value))
      ? { valid: true }
      : failure(validation, 'Choose a value from the validation range.');
  }
  if (validation.kind === 'number') {
    if (typeof value !== 'number') return failure(validation, 'Enter a number.');
    if (validation.min !== undefined && value < Number(validation.min)) {
      return failure(validation, `Enter a number greater than or equal to ${validation.min}.`);
    }
    if (validation.max !== undefined && value > Number(validation.max)) {
      return failure(validation, `Enter a number less than or equal to ${validation.max}.`);
    }
    return { valid: true };
  }
  if (validation.kind === 'date') {
    if (cell.valueType !== 'date' && cell.valueType !== 'datetime') {
      return failure(validation, 'Enter a date.');
    }
    const date = String(value).slice(0, 10);
    if (validation.min !== undefined && date < String(validation.min)) {
      return failure(validation, `Enter a date on or after ${validation.min}.`);
    }
    if (validation.max !== undefined && date > String(validation.max)) {
      return failure(validation, `Enter a date on or before ${validation.max}.`);
    }
    return { valid: true };
  }
  if (validation.kind === 'text') {
    if (typeof value !== 'string') return failure(validation, 'Enter text.');
    if (validation.min !== undefined && value.length < Number(validation.min)) {
      return failure(validation, `Enter at least ${validation.min} characters.`);
    }
    if (validation.max !== undefined && value.length > Number(validation.max)) {
      return failure(validation, `Enter no more than ${validation.max} characters.`);
    }
    return { valid: true };
  }
  return { valid: true, deferred: true };
}

export function setValidatedCell(
  document: SheetDocument,
  worksheetId: string,
  position: SheetPosition,
  cell: SheetCell | null,
  computedValues?: SheetFormulaValueMap,
): { document: SheetDocument; warning?: string } {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return { document };
  const validation = validationAt(worksheet, position);
  if (!validation) return { document: setCell(document, worksheetId, position, cell) };
  const result = validateCellAgainstValidation(
    worksheet,
    validation,
    cell,
    position,
    computedValues,
  );
  if (!result.valid && validation.strict !== false) {
    throw new SheetDocumentError('invalid-structure', result.message ?? 'The value is not valid.');
  }
  return {
    document: setCell(document, worksheetId, position, cell),
    warning: !result.valid ? result.message : undefined,
  };
}

export function countSheetValidationIssues(
  worksheet: SheetWorksheet,
  computedValues?: SheetFormulaValueMap,
): number {
  let issues = 0;
  for (const [key, cell] of Object.entries(worksheet.cells)) {
    if (!cell.validationId) continue;
    const validation = worksheet.validations?.find((rule) => rule.id === cell.validationId);
    if (!validation) continue;
    const [rowId, columnId] = key.split(':');
    const position = {
      row: worksheet.rowOrder.indexOf(rowId),
      column: worksheet.columnOrder.indexOf(columnId),
    };
    if (position.row < 0 || position.column < 0) continue;
    const result = validateCellAgainstValidation(
      worksheet,
      validation,
      cell,
      position,
      computedValues,
    );
    if (!result.valid) issues += 1;
  }
  return issues;
}

export function stableRangeFromSelection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
): SheetRange | null {
  const range = selection.ranges[0];
  if (!range) return null;
  const rectangle = normalizeRange(range);
  const startRowId = worksheet.rowOrder[rectangle.top];
  const endRowId = worksheet.rowOrder[rectangle.bottom];
  const startColumnId = worksheet.columnOrder[rectangle.left];
  const endColumnId = worksheet.columnOrder[rectangle.right];
  return startRowId && endRowId && startColumnId && endColumnId
    ? { startRowId, endRowId, startColumnId, endColumnId }
    : null;
}
