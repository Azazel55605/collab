import type { SheetErrorCode, SheetValueType } from './sheet';

export type SheetFormulaComputedValue =
  | { type: 'blank' }
  | { type: 'number'; value: number }
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'error'; value: SheetErrorCode };

export interface SheetFormulaCellInput {
  worksheetId: string;
  rowId: string;
  columnId: string;
  /** 1-based engine coordinates. */
  row: number;
  column: number;
  formula?: string;
  valueType?: SheetValueType;
  value?: string | number | boolean | null;
}

export interface SheetFormulaWorksheetInput {
  id: string;
  name: string;
}

export interface SheetFormulaEvaluationRequest {
  runtimeId: string;
  structureSignature: string;
  worksheets: SheetFormulaWorksheetInput[];
  cells: SheetFormulaCellInput[];
  evaluationTime: string;
  timeZone: string;
}

export interface SheetFormulaComputedCell {
  worksheetId: string;
  rowId: string;
  columnId: string;
  value: SheetFormulaComputedValue;
}

export interface SheetFormulaEvaluationResponse {
  cells: SheetFormulaComputedCell[];
  recalculated: number;
  incremental: boolean;
}

export type SheetFormulaValueMap = ReadonlyMap<string, SheetFormulaComputedValue>;

export function sheetFormulaResultKey(
  worksheetId: string,
  rowId: string,
  columnId: string,
): string {
  return `${worksheetId}:${rowId}:${columnId}`;
}
