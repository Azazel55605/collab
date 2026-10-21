import { afterEach, expect, it, vi } from 'vitest';

import type {
  SheetFormulaEvaluationRequest,
  SheetFormulaEvaluationResponse,
} from '../../types/sheetFormula';

import { SheetFormulaSession } from './formulaSession';

const request = (signature: string): SheetFormulaEvaluationRequest => ({
  runtimeId: 'caller-id',
  structureSignature: signature,
  worksheets: [],
  cells: [],
  evaluationTime: '2000-01-01T00:00:00Z',
  timeZone: 'UTC',
});
const response: SheetFormulaEvaluationResponse = { cells: [], recalculated: 1, incremental: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

it('waits for native completion before release so a queued evaluation cannot resurrect its runtime', async () => {
  const nativeRuntimes = new Set<string>();
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi.fn(async (input: SheetFormulaEvaluationRequest) => {
    const result = await held.promise;
    nativeRuntimes.add(input.runtimeId); // models native execution delayed after invoke
    return result;
  });
  const release = vi.fn(async (id: string) => {
    nativeRuntimes.delete(id);
  });
  const session = new SheetFormulaSession(evaluate, release);
  const result = session.submit(request('first'));
  await Promise.resolve();
  const closing = session.dispose();
  expect(release).not.toHaveBeenCalled();
  held.resolve(response);
  await result;
  await closing;
  expect(release).toHaveBeenCalledExactlyOnceWith(session.runtimeId);
  expect(nativeRuntimes.size).toBe(0);
  await session.dispose();
  expect(release).toHaveBeenCalledTimes(1);
  expect(await session.submit(request('after close'))).toBeNull();
});

it('keeps one active request and only the newest trailing request', async () => {
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue(response);
  const session = new SheetFormulaSession(
    evaluate,
    vi.fn(async () => {}),
  );
  const first = session.submit(request('first'));
  await Promise.resolve();
  const obsolete = session.submit(request('obsolete'));
  const latest = session.submit(request('latest'));
  expect(await obsolete).toBeNull();
  expect(evaluate).toHaveBeenCalledTimes(1);
  held.resolve(response);
  await first;
  await latest;
  expect(evaluate.mock.calls.map(([input]) => input.structureSignature)).toEqual([
    'first',
    'latest',
  ]);
  expect(evaluate.mock.calls.every(([input]) => input.runtimeId === session.runtimeId)).toBe(true);
  await session.dispose();
});

it('discards trailing work when a workbook closes and never evaluates an unused disposed session', async () => {
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi.fn(() => held.promise);
  const release = vi.fn(async () => {});
  const session = new SheetFormulaSession(evaluate, release);
  const first = session.submit(request('active'));
  await Promise.resolve();
  const trailing = session.submit(request('trailing'));
  const closing = session.dispose();
  expect(await trailing).toBeNull();
  held.resolve(response);
  await first;
  await closing;
  expect(evaluate).toHaveBeenCalledTimes(1);
  const unused = new SheetFormulaSession(evaluate, release);
  const cancelled = unused.submit(request('not dispatched'));
  await unused.dispose();
  expect(await cancelled).toBeNull();
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it('discards cancelled native failures, recovers trailing work and releases once', async () => {
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue(response);
  const release = vi.fn(async () => {});
  const session = new SheetFormulaSession(evaluate, release);
  const first = session.submit(request('first'));
  const failure = expect(first).resolves.toBeNull();
  await Promise.resolve();
  const latest = session.submit(request('latest'));
  held.reject(new Error('failed'));
  await failure;
  expect(await latest).toMatchObject(response);
  await session.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

it('binds volatile time at dispatch, including work queued across midnight', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T23:59:59Z'));
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue(response);
  const session = new SheetFormulaSession(
    evaluate,
    vi.fn(async () => {}),
  );
  const first = session.submit(request('first'));
  await Promise.resolve();
  const second = session.submit(request('second'));
  vi.setSystemTime(new Date('2026-10-16T00:00:02Z'));
  held.resolve(response);
  await first;
  await second;
  expect(evaluate.mock.calls.map(([input]) => input.evaluationTime)).toEqual([
    '2026-10-15T23:59:59.000Z',
    '2026-10-16T00:00:02.000Z',
  ]);
  await session.dispose();
});

it('sends one-cell deltas, merges changed outputs, removes obsolete results and reseeds evicted runtimes', async () => {
  const cells = Array.from({ length: 5000 }, (_, i) => ({
    worksheetId: 'ws',
    rowId: `r${i}`,
    columnId: 'c',
    row: i + 1,
    column: 1,
    value: i,
    valueType: 'number' as const,
  }));
  const output = {
    worksheetId: 'ws',
    rowId: 'r0',
    columnId: 'c',
    value: { type: 'number' as const, value: 1 },
  };
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce({
      cells: [output],
      recalculated: 1,
      incremental: false,
      revision: 1,
      fullResult: true,
    })
    .mockResolvedValueOnce({
      cells: [{ ...output, value: { type: 'number', value: 2 } }],
      recalculated: 1,
      incremental: true,
      revision: 2,
      fullResult: false,
    })
    .mockResolvedValueOnce({ cells: [], recalculated: 0, incremental: false, resetRequired: true })
    .mockResolvedValueOnce({
      cells: [],
      recalculated: 0,
      incremental: false,
      revision: 3,
      fullResult: true,
    });
  const session = new SheetFormulaSession(
    evaluate,
    vi.fn(async () => {}),
  );
  const first = { ...request('stable'), cells };
  await session.submit(first);
  const second = { ...first, cells: [{ ...cells[0], value: 42 }, ...cells.slice(1)] };
  const result = await session.submit(second);
  expect(result?.cells[0].value).toEqual({ type: 'number', value: 2 });
  const delta = evaluate.mock.calls[1][0];
  expect(delta.cells).toHaveLength(1);
  expect(delta.fullSeed).toBe(false);
  expect(delta.baseRevision).toBe(1);
  expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(first).length / 100);
  const after = await session.submit({ ...second, cells: cells.slice(1) });
  expect(evaluate.mock.calls[2][0].removedCells).toContain('ws:r0:c');
  expect(evaluate.mock.calls[3][0].fullSeed).toBe(true);
  expect(after?.cells).toHaveLength(0);
  await session.dispose();
});

it('reports a current native failure and permits a full-seed retry', async () => {
  const evaluate = vi
    .fn()
    .mockRejectedValueOnce(new Error('native failed'))
    .mockResolvedValue(response);
  const session = new SheetFormulaSession(
    evaluate,
    vi.fn(async () => {}),
  );
  await expect(session.submit(request('failed'))).rejects.toThrow('native failed');
  expect(await session.submit(request('retry'))).toMatchObject(response);
  expect(evaluate.mock.calls[1][0].fullSeed).toBe(true);
  await session.dispose();
});
