import { afterEach, expect, it, vi } from 'vitest';

import { BoundedWorkerPool } from './boundedWorkerPool';

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  respond(result: unknown) {
    this.onmessage?.({ data: { result } });
  }
}
afterEach(() => vi.useRealTimers());
it('bounds concurrency/queue and reuses workers without publishing a cancelled result', async () => {
  vi.useFakeTimers();
  const workers: FakeWorker[] = [];
  const pool = new BoundedWorkerPool(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    1,
    2,
  );
  const abort = new AbortController();
  const first = pool.run('first', abort.signal);
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = pool.run('second');
  await expect(pool.run('overflow')).rejects.toThrow('queue is full');
  expect(workers).toHaveLength(1);
  abort.abort();
  await rejection;
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  workers[0].respond('obsolete');
  workers[1].respond('latest');
  await expect(second).resolves.toBe('latest');
  const third = pool.run('third');
  expect(workers).toHaveLength(2);
  workers[1].respond('reused');
  await expect(third).resolves.toBe('reused');
  await vi.advanceTimersByTimeAsync(15000);
  expect(workers[1].terminate).toHaveBeenCalledOnce();
});
it('terminates stuck jobs and proceeds after an observable timeout or startup failure', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker();
  const pool = new BoundedWorkerPool(() => worker as unknown as Worker, 1);
  const stuck = pool.run('stuck', undefined, 100);
  const rejection = expect(stuck).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(worker.terminate).toHaveBeenCalledOnce();
  const broken = new BoundedWorkerPool(() => {
    throw new Error('Worker unavailable');
  });
  await expect(broken.run('work')).rejects.toThrow('Worker unavailable');
});
