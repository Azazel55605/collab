import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEmptySheetDocument } from '../../../../src/lib/sheet/document';
import { activeWorksheet, setCell } from '../../../../src/lib/sheet/operations';
import type {
  SheetFormulaEvaluationRequest,
  SheetFormulaEvaluationResponse,
} from '../../../../src/types/sheetFormula';
import { sheetFormulaEvaluate, sheetFormulaRelease } from '../mobileTauri';

import { useMobileSheetFormula } from './sheetFormula';

vi.mock('../mobileTauri', () => ({
  sheetFormulaEvaluate: vi.fn(),
  sheetFormulaRelease: vi.fn(async () => {}),
}));
function workbook() {
  const document = createEmptySheetDocument('Mobile');
  return setCell(
    document,
    activeWorksheet(document).id,
    { row: 0, column: 0 },
    { formula: '=1+1' },
  );
}
function response(input: SheetFormulaEvaluationRequest): SheetFormulaEvaluationResponse {
  return {
    cells: [{ ...input.cells[0], value: { type: 'number', value: 2 } }],
    recalculated: 1,
    incremental: false,
  };
}
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sheetFormulaEvaluate).mockImplementation(async (input) => response(input));
});
afterEach(() => vi.useRealTimers());

it('uses device timezone and waits for native work before releasing a closed screen', async () => {
  let finish!: (value: SheetFormulaEvaluationResponse) => void;
  vi.mocked(sheetFormulaEvaluate).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const document = workbook();
  const { unmount } = renderHook(() => useMobileSheetFormula(document));
  await tick();
  const input = vi.mocked(sheetFormulaEvaluate).mock.calls[0][0];
  expect(input.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  unmount();
  expect(sheetFormulaRelease).not.toHaveBeenCalled();
  await act(async () => {
    finish(response(input));
  });
  expect(sheetFormulaRelease).toHaveBeenCalledExactlyOnceWith(input.runtimeId);
});

it('does not dispatch or release a runtime when the screen closes during debounce', async () => {
  const document = workbook();
  const { unmount } = renderHook(() => useMobileSheetFormula(document));
  unmount();
  await tick();
  expect(sheetFormulaEvaluate).not.toHaveBeenCalled();
  expect(sheetFormulaRelease).not.toHaveBeenCalled();
});
