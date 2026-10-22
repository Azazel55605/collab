import { afterEach, expect, it, vi } from 'vitest';

import { backgroundPollStats, subscribeBackgroundPoll } from './backgroundPolls';
import { recordPollWake } from './performanceDiagnostics';

vi.mock('./performanceDiagnostics', () => ({ recordPollWake: vi.fn() }));

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('uses one clock, suspends hidden/offline work and catches up once on wake', async () => {
  vi.useFakeTimers();
  const a = vi.fn(),
    b = vi.fn();
  disposers.push(subscribeBackgroundPoll(a, 3000), subscribeBackgroundPoll(b, 5000));
  expect(backgroundPollStats().timers).toBe(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(a).toHaveBeenCalledTimes(1);
  expect(backgroundPollStats().timers).toBe(0);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(100);
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(2);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  window.dispatchEvent(new Event('offline'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(a).toHaveBeenCalledTimes(2);
});
it('never overlaps a slow subscriber, backs off rejection and releases its last clock', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const run = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    )
    .mockRejectedValue(new Error('offline'));
  const dispose = subscribeBackgroundPoll(run, 1000);
  disposers.push(dispose);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(20000);
  expect(run).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1900);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(run).toHaveBeenCalledTimes(3);
  dispose();
  expect(backgroundPollStats()).toEqual({ subscribers: 0, running: 0, timers: 0 });
});

it('consolidates aligned subscribers into 28 clock wakeups instead of 92 independent timer firings', async () => {
  vi.useFakeTimers();
  vi.mocked(recordPollWake).mockClear();
  const callbacks = vi.fn();
  disposers.push(subscribeBackgroundPoll(callbacks, 3000));
  for (let i = 0; i < 6; i++) disposers.push(subscribeBackgroundPoll(callbacks, 5000));
  await vi.advanceTimersByTimeAsync(60000);
  expect(callbacks).toHaveBeenCalledTimes(92);
  expect(recordPollWake).toHaveBeenCalledTimes(28);
  expect(backgroundPollStats().timers).toBe(1);
});
