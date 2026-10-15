import { StrictMode } from 'react';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  SheetFormulaEvaluationRequest,
  SheetFormulaEvaluationResponse,
} from '../../types/sheetFormula';
import { tauriCommands } from '../tauri';

import { createEmptySheetDocument } from './document';
import { activeWorksheet, setCell } from './operations';
import { useSheetFormulaEngine } from './useSheetFormulaEngine';

vi.mock('../tauri', () => ({
  tauriCommands: { sheetFormulaEvaluate: vi.fn(), sheetFormulaRelease: vi.fn(async () => {}) },
}));
function workbook(formula = '=1+1') {
  const document = createEmptySheetDocument('Test', { worksheet: { rows: 2, columns: 2 } });
  return edit(document, formula);
}
function edit(document: ReturnType<typeof createEmptySheetDocument>, formula: string) {
  return setCell(document, activeWorksheet(document).id, { row: 0, column: 0 }, { formula });
}
function response(
  input: SheetFormulaEvaluationRequest,
  value = Number(input.cells[0].formula?.match(/\d+/)?.[0] ?? 0),
): SheetFormulaEvaluationResponse {
  return {
    cells: [{ ...input.cells[0], value: { type: 'number', value } }],
    recalculated: 1,
    incremental: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(80);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(tauriCommands.sheetFormulaEvaluate).mockImplementation(async (input) =>
    response(input),
  );
  vi.mocked(tauriCommands.sheetFormulaRelease).mockClear();
});
afterEach(() => vi.useRealTimers());

it('waits for an in-flight native evaluation before releasing on unmount', async () => {
  const held = deferred<SheetFormulaEvaluationResponse>();
  vi.mocked(tauriCommands.sheetFormulaEvaluate).mockReturnValueOnce(held.promise);
  const document = workbook();
  const { unmount } = renderHook(() => useSheetFormulaEngine(document));
  await tick();
  const input = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[0][0];
  unmount();
  expect(tauriCommands.sheetFormulaRelease).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve(response(input));
  });
  expect(tauriCommands.sheetFormulaRelease).toHaveBeenCalledExactlyOnceWith(input.runtimeId);
});

it('coalesces pending edits while preserving computed values from the same workbook', async () => {
  const document = workbook();
  const { result, rerender, unmount } = renderHook(
    ({ document }) => useSheetFormulaEngine(document),
    { initialProps: { document } },
  );
  await tick();
  expect([...result.current.values.values()][0]).toEqual({ type: 'number', value: 1 });
  const held = deferred<SheetFormulaEvaluationResponse>();
  vi.mocked(tauriCommands.sheetFormulaEvaluate).mockReturnValueOnce(held.promise);
  rerender({ document: edit(document, '=2+2') });
  await tick();
  const activeInput = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[1][0];
  rerender({ document: edit(document, '=3+3') });
  await tick();
  rerender({ document: edit(document, '=4+4') });
  await tick();
  expect(tauriCommands.sheetFormulaEvaluate).toHaveBeenCalledTimes(2);
  expect([...result.current.values.values()][0]).toEqual({ type: 'number', value: 1 });
  await act(async () => {
    held.resolve(response(activeInput));
  });
  expect(
    vi
      .mocked(tauriCommands.sheetFormulaEvaluate)
      .mock.calls.map(([input]) => input.cells[0].formula),
  ).toEqual(['=1+1', '=2+2', '=4+4']);
  expect([...result.current.values.values()][0]).toEqual({ type: 'number', value: 4 });
  unmount();
});

it('isolates replacement workbooks from late responses and runtime release', async () => {
  const first = workbook();
  const second = workbook('=9+9');
  const held = deferred<SheetFormulaEvaluationResponse>();
  vi.mocked(tauriCommands.sheetFormulaEvaluate).mockReturnValueOnce(held.promise);
  const { result, rerender, unmount } = renderHook(
    ({ document }) => useSheetFormulaEngine(document),
    { initialProps: { document: first } },
  );
  await tick();
  const firstInput = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[0][0];
  rerender({ document: second });
  expect(result.current.values.size).toBe(0);
  await tick();
  const secondInput = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[1][0];
  expect(secondInput.runtimeId).not.toBe(firstInput.runtimeId);
  expect([...result.current.values.values()][0]).toEqual({ type: 'number', value: 9 });
  await act(async () => {
    held.resolve(response(firstInput));
  });
  expect([...result.current.values.values()][0]).toEqual({ type: 'number', value: 9 });
  expect(tauriCommands.sheetFormulaRelease).toHaveBeenCalledWith(firstInput.runtimeId);
  expect(tauriCommands.sheetFormulaRelease).not.toHaveBeenCalledWith(secondInput.runtimeId);
  unmount();
});

it('cancels debounce and drops queued work when formulas disappear', async () => {
  const document = workbook();
  const noFormulas = createEmptySheetDocument('Empty');
  const { result, rerender, unmount } = renderHook(
    ({ document }) => useSheetFormulaEngine(document),
    { initialProps: { document } },
  );
  rerender({ document: noFormulas });
  await tick();
  expect(tauriCommands.sheetFormulaEvaluate).not.toHaveBeenCalled();
  expect(tauriCommands.sheetFormulaRelease).not.toHaveBeenCalled();
  expect(result.current.calculating).toBe(false);
  unmount();
});

it('survives StrictMode effect replay without sharing a retired runtime', async () => {
  const document = workbook();
  const { unmount } = renderHook(() => useSheetFormulaEngine(document), { wrapper: StrictMode });
  await tick();
  expect(tauriCommands.sheetFormulaEvaluate).toHaveBeenCalledTimes(1);
  const input = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[0][0];
  expect(input.runtimeId).not.toBe('');
  expect(tauriCommands.sheetFormulaRelease).not.toHaveBeenCalled();
  unmount();
  await act(async () => {});
  expect(tauriCommands.sheetFormulaRelease).toHaveBeenCalledExactlyOnceWith(input.runtimeId);
});

it('releases the runtime after the last formula is removed', async () => {
  const document = workbook();
  const { result, rerender, unmount } = renderHook(
    ({ document }) => useSheetFormulaEngine(document),
    { initialProps: { document } },
  );
  await tick();
  const input = vi.mocked(tauriCommands.sheetFormulaEvaluate).mock.calls[0][0];
  rerender({
    document: setCell(
      document,
      activeWorksheet(document).id,
      { row: 0, column: 0 },
      { value: 2, valueType: 'number' },
    ),
  });
  await act(async () => {});
  expect(tauriCommands.sheetFormulaRelease).toHaveBeenCalledWith(input.runtimeId);
  expect(result.current.values.size).toBe(0);
  unmount();
});
