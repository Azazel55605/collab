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

it('recovers trailing work and releases after a failed evaluation', async () => {
  const held = deferred<SheetFormulaEvaluationResponse>();
  const evaluate = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue(response);
  const release = vi.fn(async () => {});
  const session = new SheetFormulaSession(evaluate, release);
  const first = session.submit(request('first'));
  const failure = expect(first).rejects.toThrow('failed');
  await Promise.resolve();
  const latest = session.submit(request('latest'));
  held.reject(new Error('failed'));
  await failure;
  expect(await latest).toBe(response);
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
