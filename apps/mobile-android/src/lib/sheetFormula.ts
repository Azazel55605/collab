/** Shared sheet request/session ownership over mobile IPC and device timezone. */
import { useMemo } from 'react';

import {
  buildSheetFormulaRequest,
  hasSheetFormulas,
} from '../../../../src/lib/sheet/formulaRequest';
import {
  type SheetFormulaState,
  useSheetFormulaSession,
} from '../../../../src/lib/sheet/useSheetFormulaSession';
import type { SheetDocument } from '../../../../src/types/sheet';
import { sheetFormulaEvaluate, sheetFormulaRelease } from '../mobileTauri';

export type MobileSheetFormulaState = SheetFormulaState;

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function useMobileSheetFormula(document: SheetDocument | null): MobileSheetFormulaState {
  const request = useMemo(
    () =>
      document && hasSheetFormulas(document)
        ? buildSheetFormulaRequest(document, '', deviceTimeZone())
        : null,
    [document],
  );
  return useSheetFormulaSession(
    request,
    document?.id ?? null,
    sheetFormulaEvaluate,
    sheetFormulaRelease,
    120,
  );
}
