import { useMemo } from 'react';

import { useUiStore } from '../../store/uiStore';
import type { SheetDocument } from '../../types/sheet';
import { tauriCommands } from '../tauri';

import { buildSheetFormulaRequest, hasSheetFormulas } from './formulaRequest';
import { type SheetFormulaState, useSheetFormulaSession } from './useSheetFormulaSession';

export { buildSheetFormulaRequest };
export type { SheetFormulaState };

export function useSheetFormulaEngine(document: SheetDocument | null): SheetFormulaState {
  const timeZone = useUiStore((state) => state.calendarDefaultTimeZone);
  const request = useMemo(
    () =>
      document && hasSheetFormulas(document)
        ? buildSheetFormulaRequest(document, '', timeZone)
        : null,
    [document, timeZone],
  );
  return useSheetFormulaSession(
    request,
    document?.id ?? null,
    tauriCommands.sheetFormulaEvaluate,
    tauriCommands.sheetFormulaRelease,
    80,
  );
}
