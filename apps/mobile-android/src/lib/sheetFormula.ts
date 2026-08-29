/**
 * Mobile formula evaluation for `.sheet` workbooks (Phase 8).
 *
 * This is the desktop `useSheetFormulaEngine` contract over the mobile IPC
 * wrappers: the request is built by the shared adapter
 * (`buildSheetFormulaRequest`) so named ranges, rule formulas, and the
 * structure signature stay identical on both clients, and evaluation runs in the
 * same bounded native runtime. Nothing about formula semantics lives here.
 *
 * The desktop hook reads its timezone from `uiStore`; mobile has no such store,
 * so the device timezone is used for the app-timezone-bound `TODAY`/`NOW`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { buildSheetFormulaRequest } from '../../../../src/lib/sheet/useSheetFormulaEngine';
import type { SheetDocument } from '../../../../src/types/sheet';
import {
  sheetFormulaResultKey,
  type SheetFormulaValueMap,
} from '../../../../src/types/sheetFormula';
import { sheetFormulaEvaluate, sheetFormulaRelease } from '../mobileTauri';

export interface MobileSheetFormulaState {
  values: SheetFormulaValueMap;
  recalculated: number;
  calculating: boolean;
  error: string | null;
}

const EVALUATE_DEBOUNCE_MS = 120;

function runtimeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `sheet-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const EMPTY: SheetFormulaValueMap = new Map();

export function useMobileSheetFormula(document: SheetDocument | null): MobileSheetFormulaState {
  const idRef = useRef(runtimeId());
  const sequenceRef = useRef(0);
  const [state, setState] = useState<MobileSheetFormulaState>({
    values: EMPTY,
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
    if (!hasFormula) return null;
    return buildSheetFormulaRequest(document, idRef.current, deviceTimeZone());
  }, [document]);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    if (!request) {
      setState({ values: EMPTY, recalculated: 0, calculating: false, error: null });
      return;
    }
    const timer = window.setTimeout(() => {
      setState((current) => ({ ...current, calculating: true, error: null }));
      sheetFormulaEvaluate(request)
        .then((response) => {
          if (sequenceRef.current !== sequence) return;
          setState({
            values: new Map(
              response.cells.map((cell) => [
                sheetFormulaResultKey(cell.worksheetId, cell.rowId, cell.columnId),
                cell.value,
              ]),
            ),
            recalculated: response.recalculated,
            calculating: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (sequenceRef.current !== sequence) return;
          setState((current) => ({
            ...current,
            calculating: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    }, EVALUATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [request]);

  // Release the native runtime when the workbook screen closes so a phone never
  // accumulates evaluation state for workbooks it is no longer showing.
  useEffect(() => {
    const id = idRef.current;
    return () => {
      void sheetFormulaRelease(id).catch(() => {});
    };
  }, []);

  return state;
}
