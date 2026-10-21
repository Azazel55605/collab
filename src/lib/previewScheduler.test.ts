import { expect, it } from 'vitest';

import { PreviewScheduler } from './previewScheduler';

const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => (resolve = done));
  return { promise, resolve };
};
it('shares a job until the last lease leaves and aborts abandoned queued/active work', async () => {
  const queue = new PreviewScheduler(1, 4);
  const gate = deferred();
  let observed!: AbortSignal;
  let calls = 0;
  const work = (signal: AbortSignal) => {
    observed = signal;
    calls++;
    return gate.promise;
  };
  const left = new AbortController(),
    right = new AbortController();
  const a = queue.run('same', work, { signal: left.signal });
  const cancelled = expect(a).rejects.toMatchObject({ name: 'AbortError' });
  const b = queue.run('same', work, { signal: right.signal });
  await Promise.resolve();
  left.abort();
  await cancelled;
  expect(observed.aborted).toBe(false);
  expect(calls).toBe(1);
  const waiting = new AbortController();
  let ran = false;
  const c = queue.run(
    'queued',
    async () => {
      ran = true;
      return 'bad';
    },
    { signal: waiting.signal },
  );
  const removed = expect(c).rejects.toMatchObject({ name: 'AbortError' });
  waiting.abort();
  await removed;
  gate.resolve('shared');
  await expect(b).resolves.toBe('shared');
  await Promise.resolve();
  expect(ran).toBe(false);
  const last = new AbortController();
  const d = queue.run(
    'active',
    (signal) => {
      observed = signal;
      return new Promise(() => {});
    },
    { signal: last.signal },
  );
  const gone = expect(d).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  last.abort();
  await gone;
  expect(observed.aborted).toBe(true);
});
it('prioritizes visible work while giving background jobs a turn and caps pending closures', async () => {
  const queue = new PreviewScheduler(1, 8);
  const gate = deferred();
  const order: string[] = [];
  const first = queue.run('block', () => gate.promise);
  const tasks = [
    queue.run(
      'background',
      async () => {
        order.push('background');
        return '';
      },
      { priority: 'background' },
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      queue.run(`visible${i}`, async () => {
        order.push(`visible${i}`);
        return '';
      }),
    ),
  ];
  gate.resolve('');
  await first;
  await Promise.all(tasks);
  expect(order.indexOf('background')).toBeGreaterThan(0);
  expect(order.indexOf('background')).toBeLessThanOrEqual(4);
  const bounded = new PreviewScheduler(1, 1);
  const abort = new AbortController();
  const occupied = bounded.run('one', () => new Promise(() => {}), { signal: abort.signal });
  const rejection = expect(occupied).rejects.toMatchObject({ name: 'AbortError' });
  await expect(bounded.run('two', async () => 0)).rejects.toThrow('queue is full');
  abort.abort();
  await rejection;
});

it('can request the same key immediately after its previous lease settles', async () => {
  const queue = new PreviewScheduler(1);
  expect(await queue.run('same', async () => 1)).toBe(1);
  expect(await queue.run('same', async () => 2)).toBe(2);
  expect(queue.stats()).toEqual({ active: 0, jobs: 0 });
});
