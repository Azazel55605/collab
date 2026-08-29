import { useEffect, useMemo, useRef, useState } from 'react';

import { useUiStore } from '../../store/uiStore';
import type { SheetDocument } from '../../types/sheet';
import {
  type SheetFormulaEvaluationRequest,
  sheetFormulaResultKey,
  type SheetFormulaValueMap,
} from '../../types/sheetFormula';
import { tauriCommands } from '../tauri';

import { buildSheetRuleFormulaInputs } from './formulaRules';
import { expandNamedRangesInFormula } from './namedRanges';

export interface SheetFormulaState {
  values: SheetFormulaValueMap;
  recalculated: number;
  calculating: boolean;
  error: string | null;
}

function runtimeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export function useSheetFormulaEngine(document: SheetDocument | null): SheetFormulaState {
  const idRef = useRef(runtimeId());
  const requestSequence = useRef(0);
  const timeZone = useUiStore((state) => state.calendarDefaultTimeZone);
  const [state, setState] = useState<SheetFormulaState>({
    values: new Map(),
    recalculated: 0,
    calculating: false,
    error: null,
  });
  const request = useMemo(() => {
    if (!document) return null;
    const hasFormula = document.worksheets.some(
      (worksheet) =>
        Object.values(worksheet.cells).some((cell) => Boolean(cell.formula)) ||
        worksheet.conditionalFormats?.some((rule) => rule.kind === 'formula') ||
        worksheet.validations?.some((rule) => rule.kind === 'custom'),
    );
    return hasFormula ? buildSheetFormulaRequest(document, idRef.current, timeZone) : null;
  }, [document, timeZone]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (!request) {
      setState({ values: new Map(), recalculated: 0, calculating: false, error: null });
      return;
    }
    const timeout = window.setTimeout(() => {
      setState((current) => ({ ...current, calculating: true, error: null }));
      tauriCommands
        .sheetFormulaEvaluate(request)
        .then((response) => {
          if (requestSequence.current !== sequence) return;
          const values = new Map(
            response.cells.map((cell) => [
              sheetFormulaResultKey(cell.worksheetId, cell.rowId, cell.columnId),
              cell.value,
            ]),
          );
          setState({
            values,
            recalculated: response.recalculated,
            calculating: false,
            error: null,
          });
        })
        .catch((error) => {
          if (requestSequence.current !== sequence) return;
          setState((current) => ({
            ...current,
            calculating: false,
            error: String(error),
          }));
        });
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [request]);

  useEffect(
    () => () => {
      void tauriCommands.sheetFormulaRelease(idRef.current).catch(() => undefined);
    },
    [],
  );

  return state;
}
