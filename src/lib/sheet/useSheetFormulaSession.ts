import { useEffect, useRef, useState } from 'react';

import {
  type SheetFormulaEvaluationRequest,
  sheetFormulaResultKey,
  type SheetFormulaValueMap,
} from '../../types/sheetFormula';

import {
  type EvaluateSheetFormula,
  type ReleaseSheetFormula,
  SheetFormulaSession,
} from './formulaSession';

export interface SheetFormulaState {
  values: SheetFormulaValueMap;
  recalculated: number;
  calculating: boolean;
  error: string | null;
  recalculate?: () => void;
}
interface ScopedFormulaState extends SheetFormulaState {
  scope: string | null;
}
const EMPTY_VALUES: SheetFormulaValueMap = new Map();
const emptyState = (scope: string | null): ScopedFormulaState => ({
  scope,
  values: EMPTY_VALUES,
  recalculated: 0,
  calculating: false,
  error: null,
});

/** Lifecycle logic shared by desktop and Android; adapters supply IPC/timezone/debounce. */
export function useSheetFormulaSession(
  request: SheetFormulaEvaluationRequest | null,
  scope: string | null,
  evaluate: EvaluateSheetFormula,
  release: ReleaseSheetFormula,
  debounceMs: number,
): SheetFormulaState {
  const ownerRef = useRef<SheetFormulaSession | null>(null);
  const [state, setState] = useState<ScopedFormulaState>(() => emptyState(scope));
  const enabled = Boolean(request);
  const [recalculation, setRecalculation] = useState(0);
  const recalculate = () => setRecalculation((value) => value + 1);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (
        document.visibilityState !== 'hidden' &&
        requestRef.current?.cells.some((cell) =>
          /\b(?:NOW|TODAY|RAND|RANDBETWEEN)\s*\(/i.test(cell.formula ?? ''),
        )
      )
        setRecalculation((value) => value + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [enabled, scope]);

  useEffect(() => {
    if (!enabled) return;
    const owner = new SheetFormulaSession(evaluate, release);
    ownerRef.current = owner;
    // Never show computed values from a previously mounted workbook.
    setState(emptyState(scope));
    return () => {
      ownerRef.current = null;
      void owner
        .dispose()
        .catch((error) => console.warn('[sheet] formula runtime release failed', error));
    };
  }, [scope, enabled, evaluate, release]);

  useEffect(() => {
    const owner = ownerRef.current;
    let current = true;
    if (!request || !owner) {
      setState(emptyState(scope));
      return;
    }
    const timer = window.setTimeout(() => {
      setState((previous) => ({ ...previous, calculating: true, error: null }));
      void owner
        .submit(request)
        .then((response) => {
          if (!current || !response) return;
          setState({
            scope,
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
        .catch((error) => {
          if (!current) return;
          setState((previous) => ({ ...previous, calculating: false, error: String(error) }));
        });
    }, debounceMs);
    return () => {
      current = false;
      window.clearTimeout(timer);
      owner.cancelPending();
    };
  }, [request, scope, enabled, evaluate, release, debounceMs, recalculation]);

  return { ...(state.scope === scope && enabled ? state : emptyState(scope)), recalculate };
}
